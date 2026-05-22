import { WorkerEntrypoint } from "cloudflare:workers";
import { HttpError, LogLevel, SharedHeaders } from "miniflare:shared";
import { CoreBindings, CoreHeaders, CorePaths } from "./constants";
import { handleEmail } from "./email";
import { handleScheduled } from "./scheduled";

type Env = {
	[CoreBindings.SERVICE_LOOPBACK]: Fetcher;
	[CoreBindings.SERVICE_WORKER_FETCH_TARGET]: Fetcher;
	[CoreBindings.SERVICE_WORKER_RPC_TARGET]: Fetcher | Service;
	[CoreBindings.TEXT_UPSTREAM_URL]?: string;
	[CoreBindings.DATA_PROXY_SHARED_SECRET]?: ArrayBuffer;
	[CoreBindings.TRIGGER_HANDLERS]: boolean;
	[CoreBindings.STRIP_DISABLE_PRETTY_ERROR]: boolean;
};

const encoder = new TextEncoder();

function getUserRequest(
	request: Request<unknown, IncomingRequestCfProperties>,
	env: Env
) {
	const originalUrl = request.headers.get(CoreHeaders.ORIGINAL_URL);
	let url = new URL(originalUrl ?? request.url);

	let rewriteHeadersFromOriginalUrl = false;

	const proxySharedSecret = request.headers.get(
		CoreHeaders.PROXY_SHARED_SECRET
	);
	if (proxySharedSecret) {
		const secretFromHeader = encoder.encode(proxySharedSecret);
		const configuredSecret = env[CoreBindings.DATA_PROXY_SHARED_SECRET];
		if (
			secretFromHeader.byteLength === configuredSecret?.byteLength &&
			crypto.subtle.timingSafeEqual(secretFromHeader, configuredSecret)
		) {
			rewriteHeadersFromOriginalUrl = true;
		} else {
			throw new HttpError(
				400,
				`Disallowed header in request: ${CoreHeaders.PROXY_SHARED_SECRET}=${proxySharedSecret}`
			);
		}
	}

	const upstreamUrl = env[CoreBindings.TEXT_UPSTREAM_URL];
	const originalHostname = upstreamUrl !== undefined ? url.host : undefined;
	if (upstreamUrl !== undefined) {
		let path = url.pathname + url.search;
		if (path.startsWith("/")) {
			path = `./${path.substring(1)}`;
		}
		url = new URL(path, upstreamUrl);
		rewriteHeadersFromOriginalUrl = true;
	}

	request = new Request(url, request);
	request.headers.set("Accept-Encoding", "br, gzip");

	const secFetchMode = request.headers.get(CoreHeaders.SEC_FETCH_MODE);
	if (secFetchMode) {
		request.headers.set("Sec-Fetch-Mode", secFetchMode);
	}
	request.headers.delete(CoreHeaders.SEC_FETCH_MODE);

	if (rewriteHeadersFromOriginalUrl) {
		request.headers.set("Host", url.host);
	}

	if (originalHostname !== undefined) {
		request.headers.set(CoreHeaders.ORIGINAL_HOSTNAME, originalHostname);
	}

	const clientIp =
		request.headers.get(CoreHeaders.CLIENT_IP) ??
		(request.cf?.clientIp as string | undefined);
	if (clientIp && !request.headers.get("CF-Connecting-IP")) {
		const ipv4Regex = /(?<ip>.*?):\d+/;
		const ipv6Regex = /\[(?<ip>.*?)\]:\d+/;
		const ip =
			clientIp.match(ipv6Regex)?.groups?.ip ??
			clientIp.match(ipv4Regex)?.groups?.ip;

		if (ip) {
			request.headers.set("CF-Connecting-IP", ip);
		}
	}

	request.headers.delete(CoreHeaders.PROXY_SHARED_SECRET);
	request.headers.delete(CoreHeaders.ORIGINAL_URL);
	request.headers.delete(CoreHeaders.CLIENT_IP);
	if (env[CoreBindings.STRIP_DISABLE_PRETTY_ERROR]) {
		request.headers.delete(CoreHeaders.DISABLE_PRETTY_ERROR);
	}
	return request;
}

export default class IngressWorker extends WorkerEntrypoint<Env> {
	async fetch(request: Request<unknown, IncomingRequestCfProperties>) {
		const env = this.env;
		const url = new URL(
			request.headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url
		);
		if (env[CoreBindings.TRIGGER_HANDLERS]) {
			if (
				url.pathname === CorePaths.SCHEDULED ||
				url.pathname === CorePaths.LEGACY_SCHEDULED
			) {
				if (url.pathname === CorePaths.LEGACY_SCHEDULED) {
					this.ctx.waitUntil(
						env[CoreBindings.SERVICE_LOOPBACK].fetch(
							"http://localhost/core/log",
							{
								method: "POST",
								headers: {
									[SharedHeaders.LOG_LEVEL]: LogLevel.WARN.toString(),
								},
								body: `Triggering scheduled handlers via a request to \`${CorePaths.LEGACY_SCHEDULED}\` is deprecated, and will be removed in a future version of Miniflare. Instead, send a request to \`${CorePaths.SCHEDULED}\``,
							}
						)
					);
				}

				return handleScheduled(
					url.searchParams,
					env[CoreBindings.SERVICE_WORKER_RPC_TARGET]
				);
			}

			if (url.pathname === CorePaths.EMAIL) {
				return handleEmail(
					url.searchParams,
					request,
					env[CoreBindings.SERVICE_WORKER_RPC_TARGET],
					env,
					this.ctx
				);
			}

			if (url.pathname.startsWith(CorePaths.HANDLER_PREFIX)) {
				return new Response(
					`"${url.pathname}" is not a valid handler. Did you mean to use "${CorePaths.SCHEDULED}" or "${CorePaths.EMAIL}"?`,
					{ status: 404 }
				);
			}
		}

		try {
			request = getUserRequest(request, env);
		} catch (e) {
			if (e instanceof HttpError) {
				return e.toResponse();
			}
			throw e;
		}

		return env[CoreBindings.SERVICE_WORKER_FETCH_TARGET].fetch(request);
	}

	constructor(ctx: ExecutionContext, env: Env) {
		super(ctx, env);

		return new Proxy(this, {
			get(target, prop) {
				if (prop === "fetch") {
					return target.fetch.bind(target);
				}

				if (prop === "env" || prop === "ctx") {
					return Reflect.get(target, prop);
				}

				const value = Reflect.get(
					target.env[CoreBindings.SERVICE_WORKER_RPC_TARGET],
					prop
				);
				return typeof value === "function"
					? value.bind(target.env[CoreBindings.SERVICE_WORKER_RPC_TARGET])
					: value;
			},
		});
	}
}

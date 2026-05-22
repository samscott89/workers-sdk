export type WorkerRegistry = Record<string, WorkerDefinition>;

export type WorkerDefinition = {
	/**
	 * Address of the workerd debug port for this worker's process (e.g. "127.0.0.1:12345").
	 * The debug port provides native Cap'n Proto RPC access to all services/entrypoints.
	 */
	debugPortAddress: string;
	/**
	 * The workerd service name for the default entrypoint. This points to the
	 * worker's ingress service, which applies default fetch routing before the raw
	 * user worker runs.
	 */
	defaultEntrypointService: string;
	/**
	 * The workerd service name for the user worker directly
	 * This bypasses the ingress layer for named entrypoints and Durable Objects.
	 */
	userWorkerService: string;
};

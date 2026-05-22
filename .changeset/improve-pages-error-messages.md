---
"wrangler": patch
---

Improve error messages for Pages CLI commands

Error messages across `wrangler pages` subcommands (deploy, dev, secret, project, etc.) now provide clearer descriptions and actionable guidance. For example, instead of "Must specify a project name.", you'll now see "Missing Pages project name. Use --project-name <name> or set the name in your wrangler.jsonc configuration file."

Input validation errors also now use `UserError` instead of `FatalError` for more accurate error classification.

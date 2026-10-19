# Security policy

## Supported versions

Only the [latest release](https://github.com/jjongguet/gjc-plugin/releases/latest) receives fixes. Each plugin's version is in its `gajae-plugin.json`.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://github.com/jjongguet/gjc-plugin/security/advisories/new)). Do not open a public issue for a vulnerability.

Include the plugin and version, the tool or hook involved, the input or environment needed to reproduce, and the impact you observed. Never include real credentials, API keys or personal data in a report; use synthetic values.

You will get an acknowledgement on the advisory. Confirmed issues are fixed in a new release and disclosed through the advisory once the release is available.

## Scope

In scope: the plugin bundles in this repository, their generated tool and hook surfaces, the private result store under `~/.gjc-plugin/`, and the repository's CI workflows. Particularly relevant are credential handling (`~/.gjc/agent/jev-advisor/.env`), file-permission and symlink checks on private stores, process isolation in the test and browser runners, and any path by which a tool could write outside its own store or send data to an unexpected endpoint.

Out of scope: vulnerabilities in gajae-code itself, Aside, REA (`rea-agents`), OpenRouter or other upstream services; report those to their maintainers.

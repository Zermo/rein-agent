# Find an already running model server

Interactive `rein setup` checks localhost, explicitly configured endpoints, and
known private LAN/mesh peers. It reads the LAN neighbor table, `tailscale status
--json`, and `netbird status --json` when those commands are available. Only online
private mesh peer addresses are candidates; relay and control-plane addresses are
excluded. These commands do not log into the mesh or change its configuration.

```sh
rein models --discover-network
rein models --discover-network --json
rein setup --connection-only
```

The common listening ports are 11434, 1234, 8080, and 8000. Ports in saved endpoints
or explicit hints are included. Server names require API evidence; the same port
can host different software.

| State | What to do |
| --- | --- |
| `ready` | Select a listed model; setup will verify a chat reply. |
| `auth-required` | Choose the server and enter its key at the hidden prompt. |
| `no-models` | Load a model in the serving app, then retry or enter its exact ID. |
| `unreachable` | Check the listener, route, port, firewall, and mesh connection. |
| `incompatible` | Use a model API URL; the address may be a web dashboard. |
| `skipped` | A scan limit was reached; specify the endpoint directly. |

The scan has a 10-second budget, at most 16 discovered peers and 80 endpoint
candidates, and 8 concurrent probes. Each response is bounded to 1 MiB. It never
sweeps a subnet or tries every port. An unavailable peer command and a time or
candidate limit are shown in the report; no result does not prove no server exists.

For a missing host or an unusual port:

```sh
rein models --discover-hosts model-host --discover-ports 9000
rein models --discover-hosts http://model-host:9000/proxy/v1
rein setup --base-url http://model-host:9000/proxy/v1 --api chat-completions
```

Replace the sample hostname, port, and prefix with the values from your server.
`--discover-hosts` and `--discover-ports` also work in setup. They accept comma-separated
values; CIDR ranges are not expanded. You can disable peer checks in interactive
setup with `--discover-network=false`. `rein models` defaults to local/configured discovery. Unattended `setup --yes`
reuses the selected or saved connection; if none is configured, it checks local
listeners. Pass `--discover-network` to include known peers when discovery is needed.

A server that listens only on its own loopback interface cannot be discovered
through its LAN or mesh IP. Use your existing SSH configuration:

```sh
rein setup --ssh model-host --base-url 127.0.0.1:1234 --api chat-completions
```

Rein only attempts saved/explicit SSH routes. It does not try aliases from your
SSH config on its own. With `--ssh`, the URL belongs to the remote machine.
Without it, `127.0.0.1` means the computer running Rein.

For a saved private IPv4 SSH host on port 22, Rein can recover an unreachable
address through another private address already recorded with the same host key
in the default SSH known-hosts file. OpenSSH still verifies the original host
identity with strict checking. The recovery changes no SSH settings or trust
records. Custom proxies, host-key aliases, trust stores, hashed-only records,
and other ports retain their configured route. At most four alternate addresses
are checked. This does not repair a mesh service or sweep a subnet.

The desktop setup's model search includes the saved endpoint and its SSH route.
Selecting that saved result preserves the connection instead of treating the
remote loopback URL as a server on the laptop.

Discovery reads model metadata only. Saved credentials are used only for their
exact configured API URL and SSH route; keys are never attached to newly found
peers. Cross-origin redirects are rejected. Setup collects any needed key after
you select a server and verifies a Chat Completions response before saving.

See [Self-hosted models](https://github.com/Zermo/rein-agent/wiki/Self-hosted-models)
for listener setup and [Hardware and serving](https://github.com/Zermo/rein-agent/wiki/Hardware-and-serving)
for model-fit estimates and recipes.

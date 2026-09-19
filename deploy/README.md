# Deployment

Deployment is replaceable infrastructure. The application must not know whether it runs on SumoPod, a generic VPS, a home server, Docker Desktop, Kubernetes, or another platform.

## Generic Docker host

Copy the environment template, then run:

```bash
cp .env.example .env
docker compose -f deploy/compose.yaml up -d companion-core
```

To run the optional Hermes sidecar too:

```bash
docker compose -f deploy/compose.yaml --profile hermes up -d
```

Hermes port 8642 is intentionally **not published to the public host interface** in this compose file. Companion Core talks to it over the private Docker network.

## Production rule

Terminate TLS at a reverse proxy or managed ingress and expose only the Companion Gateway endpoint needed by devices. Keep model API keys, Hermes API keys and databases server-side.

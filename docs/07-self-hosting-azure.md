# Self-hosting on Azure

This guide puts Poker Planning on Azure App Service with Azure Database for PostgreSQL Flexible
Server, using the Bicep template in [`infra/`](../infra). It assumes you have never used Azure.
[ADR-032](05-decisions.md) has the reasons for each choice. The general guide (Docker Compose,
every variable, upgrades, Coolify) is the [README](../README.md#self-hosting).

> **What has been tested (2026-11-02).** The template compiles and lints clean, offline, and CI
> repeats that on every pull request. The handling of App Service's `X-Forwarded-For` has unit
> tests, built from a third party's report of what the front end sends. **Nothing in this guide
> has been run against Azure yet:** no command below, no deployment, no restore. It was written
> from Microsoft's documentation of that date. Issue #38 stays open until someone has followed it
> on a fresh subscription.

## What you get

| Resource | Size | Why |
|---|---|---|
| App Service plan on Linux | `B1`, one instance | runs the container. Basic is the smallest tier with Always On |
| Web app | | the container, on port 3000, with WebSockets, HTTPS only, Always On and a health check |
| Postgres 17 Flexible Server | `Standard_B1ms`, 32 GB, 7 days of backups | no public address, reachable only from your network |
| Virtual network and private DNS zone | | connect the two |
| Managed identity | | lets the web app pull the image, so no registry password exists |
| Container registry | Basic | your own copy of the image: none is published anywhere |

## Before you start

- **An Azure subscription**, with you as Owner, which you are if you created it. Go to
  https://azure.microsoft.com, choose "Try Azure for free" or "Pay as you go", and sign in with a
  Microsoft account. This costs money from the moment you deploy: see "Cost".
- **The Azure CLI** (`az`), https://learn.microsoft.com/cli/azure/install-azure-cli
- **Docker** 25 or newer, which has BuildKit on by default. Docker Desktop is fine, and it
  must be running. If you cannot have Docker, see "Without Docker".
- **Git**, **openssl** and a **Bash** shell. On Windows, Git Bash has all three.

Run every command from the top folder of the repository, in one terminal.

## 1. Sign in

```sh
az login
az account show --query "{subscription:name, id:id}" --output table
```

`az login` opens a browser. If the second command shows the wrong subscription, choose yours with
`az account set --subscription "<name or id>"`.

A new subscription does not know the services this guide uses yet. Tell it, once:

```sh
for provider in Microsoft.Web Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
  Microsoft.Network Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait
done
```

## 2. Get the code

```sh
git clone https://github.com/sven-borden/self-host-poker-planning.git
cd self-host-poker-planning
```

## 3. Choose names and make the secrets

Pick a name for your install. It becomes part of the web address and must be free across all of
Azure: 3 to 40 characters, lower-case letters, digits and hyphens, starting with a letter. Here it
is `poker-acme`, and the registry is the same without hyphens. Pick a region near your people;
`az account list-locations --output table` lists them, by the `Name` column.

Change the first four lines, then run this **once**:

```sh
cat > infra/.env.azure <<EOF
export AZURE_RESOURCE_GROUP=poker-planning
export AZURE_LOCATION=westeurope
export POKER_NAME=poker-acme
export POKER_REGISTRY=pokeracme
export POKER_POSTGRES_PASSWORD='$(openssl rand -base64 24)'
export POKER_BETTER_AUTH_SECRET='$(openssl rand -base64 32)'
EOF
chmod 600 infra/.env.azure
. infra/.env.azure
git check-ignore infra/.env.azure
```

The last line must print `infra/.env.azure`: git ignores that file, so it cannot be committed. Every
later deployment reads it. **Copy the file to your password manager now.** If you lose it, you lose
the Postgres password, and a new `POKER_BETTER_AUTH_SECRET` signs everybody out. Running the block
again would make new secrets. In a new terminal, load the file again with `. infra/.env.azure`.

The Postgres password is base64 rather than hex because Azure wants three kinds of character. Its
`/`, `+` and `=` are safe: the template encodes them for the connection string.

`infra/main.bicepparam` holds no value of its own: it reads these variables, which is why it can
stay in git. Never type a secret into it. Do not run `bicep build-params` on a real environment:
it writes the values out, and `infra/*.parameters.json` is ignored for that reason.

## 4. Create the resource group and the registry

```sh
az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION"
az acr create --resource-group "$AZURE_RESOURCE_GROUP" --name "$POKER_REGISTRY" --sku Basic
```

If the registry name is taken, choose another, change `POKER_REGISTRY` in `infra/.env.azure`, and
load the file again.

## 5. Build the image and push it

```sh
export POKER_IMAGE_TAG=$(git rev-parse --short=12 HEAD)
REGISTRY_SERVER=$(az acr show --name "$POKER_REGISTRY" --query loginServer --output tsv)
az acr login --name "$POKER_REGISTRY"
docker build --platform linux/amd64 \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
  --build-arg APP_VERSION="$(git describe --tags --always)" \
  --tag "$REGISTRY_SERVER/poker-planning:$POKER_IMAGE_TAG" .
docker push "$REGISTRY_SERVER/poker-planning:$POKER_IMAGE_TAG"
```

The first build takes some minutes. The two build arguments are what `/api/health` reports later.
`--platform` matters on an Apple Silicon or other ARM machine: App Service runs `linux/amd64`.

## 6. Deploy

```sh
az deployment group create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/main.bicep \
  --parameters infra/main.bicepparam \
  --query properties.outputs.baseUrl.value --output tsv
```

Expect many minutes: Postgres is the slow part. It ends by printing your address, such as
`https://poker-acme.azurewebsites.net`. It may look different, because Azure can give new apps a
longer unique name; the template reads whichever it is into `BASE_URL`.

Secrets are `@secure()` parameters: Azure masks them in the deployment history, and no output
carries them.

## 7. Check it

The web app still has to pull the image and start, and the first start applies the migrations. Give
it some minutes, then:

```sh
POKER_URL=https://<the address printed above>
curl -s "$POKER_URL/api/health"
```

It should answer with `"status":"ok"`, `"db":"ok"`, and your commit from `git rev-parse HEAD`.

To watch the start, or if it does not answer:

```sh
az webapp log config --resource-group "$AZURE_RESOURCE_GROUP" --name "$POKER_NAME" \
  --docker-container-logging filesystem
az webapp log tail --resource-group "$AZURE_RESOURCE_GROUP" --name "$POKER_NAME"
```

Then check what a health answer cannot:

1. Open the address in two browsers and join one room from both. Vote in one: the other shows
   that someone voted. In the browser's developer tools, under Network, `socket.io` shows a request
   with status 101. Reveal.
2. Start a short timer, close every tab, and open the room after it ended. The reveal has happened.
3. Create rooms until the app refuses: one address gets 20 in 10 minutes. Then create one from a
   phone on mobile data. It must work. If the phone is refused too, every visitor shares one
   address, and `TRUST_PROXY` or the header parsing is wrong for what your front end sends.
4. Check that Postgres is private. This must print `Disabled`:

   ```sh
   az postgres flexible-server show --resource-group "$AZURE_RESOURCE_GROUP" \
     --name "$POKER_NAME-db" --query network.publicNetworkAccess --output tsv
   ```

## Without Docker

Do not use `az acr build`. It uses Docker's classic builder, and the Dockerfile's `RUN --mount`
needs BuildKit. `infra/acr-task.yaml` runs the same build in the registry with BuildKit turned on,
which works from Azure Cloud Shell too. In place of step 5:

```sh
export POKER_IMAGE_TAG=$(git rev-parse --short=12 HEAD)
az acr run --registry "$POKER_REGISTRY" --file infra/acr-task.yaml --timeout 3000 \
  --set tag="$POKER_IMAGE_TAG" \
  --set commit="$(git rev-parse HEAD)" \
  --set version="$(git describe --tags --always)" .
```

This route is the less certain one. Microsoft documents `DOCKER_BUILDKIT=1` for such a task, but
the Docker version inside is Microsoft's, and Microsoft says ACR Tasks are paused for subscriptions
funded by free credits: there, it fails with "ACR Tasks requests ... are not permitted", and you
need a pay-as-you-go subscription or Docker.

## A custom domain

The server accepts a WebSocket only from `BASE_URL`, so the domain and `BASE_URL` change together.
For `poker.example.com`:

1. Find the two values for your DNS:

   ```sh
   az webapp show --resource-group "$AZURE_RESOURCE_GROUP" --name "$POKER_NAME" \
     --query "{cname:defaultHostName, txt:customDomainVerificationId}"
   ```

2. At your DNS provider, add a `CNAME` record from `poker` to the `cname` value, and a `TXT` record
   named `asuid.poker` with the `txt` value. The free certificate needs the `CNAME` to point
   directly at the app. A root domain (`example.com`) needs an `A` record instead: see
   [Microsoft's page](https://learn.microsoft.com/azure/app-service/configure-ssl-certificate).
3. Bind the name and a free managed certificate. It can take some minutes:

   ```sh
   export POKER_CUSTOM_DOMAIN=poker.example.com
   az webapp config hostname add --resource-group "$AZURE_RESOURCE_GROUP" \
     --webapp-name "$POKER_NAME" --hostname "$POKER_CUSTOM_DOMAIN"
   THUMBPRINT=$(az webapp config ssl create --resource-group "$AZURE_RESOURCE_GROUP" \
     --name "$POKER_NAME" --hostname "$POKER_CUSTOM_DOMAIN" --query thumbprint --output tsv)
   az webapp config ssl bind --resource-group "$AZURE_RESOURCE_GROUP" --name "$POKER_NAME" \
     --certificate-thumbprint "$THUMBPRINT" --ssl-type SNI
   ```

   `ssl create` is marked preview in the CLI. The same is in the portal: your web app, then
   **Certificates**, **Managed certificates**, **Add certificate**, then a binding under
   **Custom domains**.
4. Add `export POKER_CUSTOM_DOMAIN=poker.example.com` to `infra/.env.azure`, load it, and repeat
   step 6. The app restarts with the new `BASE_URL`. People on the old address can load the page but
   not join a room, so send them the new one.
5. Change anything built on the old address: the redirect URIs of Google, Microsoft and Jira.

The health check keeps pinging the default host name, which is what App Service does and needs no
change. Do not add a redirect from it, because a check that gets a 301 counts as a failure.

## Optional variables

The template's app settings replace the whole list on every deployment, so a setting made by hand
in the portal is gone after the next one. Put them in `infra/.env.azure` instead, as one line of
JSON, then repeat step 6:

```sh
export POKER_EXTRA_SETTINGS='{"ROOM_TTL_DAYS":"30","GOOGLE_CLIENT_ID":"...","GOOGLE_CLIENT_SECRET":"..."}'
```

Every value is a string. The README has all of them: sign-in, connector tokens, Jira, Azure DevOps,
Sentry and Umami. The settings the template sets itself (`BASE_URL`, `DATABASE_URL`, `TRUST_PROXY`,
`BETTER_AUTH_SECRET`, `PORT` and the `WEBSITES_*` ones) win over this list.

`POKER_PLAN_SKU` chooses a larger plan, such as `S1`. `F1`, `D1` and any tier without Always On are
refused by the template. Other template parameters, such as `postgresBackupDays`, keep their default
unless you add them to `infra/main.bicepparam`.

## Upgrading

An upgrade is steps 5 and 6 again, after `git pull`. Load `infra/.env.azure` first. A deployment needs
the image tag each time, so it can never roll the image back by accident. App Service keeps the old
container serving until the new one answers. The new one applies pending migrations before it
listens, and rooms, even rounds in progress, live in Postgres and survive.

To go back, repeat step 6 with the earlier tag in `POKER_IMAGE_TAG`. Old tags stay in the registry
and count towards its storage; delete those you no longer want.

The base images need updating by hand (README, "Base image updates").

## Backups and restoring

Flexible Server backs up by itself and keeps 7 days by default, up to 35
(`postgresBackupDays`). You can restore to any point in that time, always into a **new** server.
Backups stay in the region: geo-redundant backup is off, and can only be chosen at creation.

A database has no public address, so `pg_dump` from your machine does not reach it. If you want
dumps outside Azure, you need a machine in the network, which this guide does not cover.

**Read this before restoring.** The retention purge deletes every room idle past `ROOM_TTL_DAYS`
3 to 5 minutes after the server starts, and a restored database is old. So:

1. Add `"ROOM_TTL_DAYS":"3650"` to `POKER_EXTRA_SETTINGS` and load the file.
2. Restore into a new name, with a time in UTC:

   ```sh
   az postgres flexible-server restore --resource-group "$AZURE_RESOURCE_GROUP" \
     --name "$POKER_NAME-db2" --source-server "$POKER_NAME-db" \
     --restore-time "2026-11-02T08:00:00Z"
   ```

3. Add `export POKER_POSTGRES_SERVER=$POKER_NAME-db2` to `infra/.env.azure` (after the line that sets
   `POKER_NAME`), load it, and repeat step 6. The app moves to the restored server.
4. Once people have opened the rooms they care about, or you have accepted losing the others, take
   `ROOM_TTL_DAYS` out again and repeat step 6.
5. Delete the old server when you are sure, with `az postgres flexible-server delete`.

The connectors' tokens stay encrypted in a backup, and `POKER_VAULT_KEY` is not in it, so keep the
key apart from Azure's backups (README, "Connector tokens").

## What this setup assumes

- **One instance.** Do not scale out in the portal. More than one needs `REDIS_URL`, and sockets
  then use WebSocket only (README, "Running several instances"). The template fixes the count at 1.
  Scaling up to a larger tier is fine. Autoscale stays off.
- **Always On.** The server reveals timers and purges old rooms by itself, which needs a process
  that stays up. App Service stops an idle app without it, so the template sets it and refuses the
  tiers that lack it.
- **WebSockets.** Microsoft gives about 50,000 per instance for Linux from Basic up, and 5 on Free.
- **`TRUST_PROXY=1`.** App Service's front end is the one proxy, and clients cannot reach the
  container past it. The front end writes `ip:port` into `X-Forwarded-For`, which the server handles.
- **Affinity is on.** App Service sets its own `ARRAffinity` cookies. They only pin a browser to an
  instance, which keeps Socket.IO's long-polling on one process when App Service briefly runs two.
- **The image's `HEALTHCHECK` is ignored here.** App Service pings `/api/health` once a minute
  instead. On one instance a failing check does not take the app out of service, and after an
  hour of failures App Service replaces the instance.

## Logs and privacy

Container logs hold only what the server writes, which never includes a room code or a secret. Keep
it that way: **do not send `AppServiceHTTPLogs` to Log Analytics or turn on Application Insights for
this app.** Those record request paths, and `/r/<code>` carries a room code, which works as a key to
the room. This template turns on neither.

App settings, `DATABASE_URL` and `BETTER_AUTH_SECRET` included, are readable by anyone with
Contributor rights on the app. Give that role only to people you would give the secrets to.

## Cost

This guide gives no monthly figure. On 2026-11-02 Microsoft's pricing pages for App Service and the
container registry showed no number to a plain reader, only `$-`, because the prices load in the
browser by region and currency, and a guessed figure would be worse than none.

To get yours, open https://azure.microsoft.com/pricing/calculator and add these, for your region:

- App Service, Linux, Basic `B1`, one instance
- Azure Database for PostgreSQL, Flexible Server, Burstable `B1ms`, 32 GB of storage
- Container Registry, Basic

Add small amounts for the backup storage and the private DNS zone. Virtual network integration has
no charge of its own. All of it runs around the clock, used or not, so
[set a budget alert](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
on the resource group. The only way to stop paying is to delete it.

## Troubleshooting

Each of these is what the documentation or the code leads us to expect, not something seen on a real
deployment yet.

| What you see | Likely reason | What to do |
|---|---|---|
| `az deployment` fails with "location is restricted" or offer restricted for Postgres | new subscriptions cannot create Flexible Server in every region | delete the group, change `AZURE_LOCATION` and start again at step 4 |
| The log shows the image pull refused, `UNAUTHORIZED` | the role is still spreading, or the registry refuses ARM tokens | wait some minutes and run `az webapp restart`; then `az acr config authentication-as-arm show --registry "$POKER_REGISTRY"` must say enabled |
| `Invalid configuration: ...` in the log | a variable is missing or malformed; the message names it | check `POKER_EXTRA_SETTINGS`: a pair such as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` needs both |
| `database: not reachable, retrying` with a code such as `ERR_TLS_CERT_ALTNAME_INVALID` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | `sslmode=verify-full` failed on your network; Microsoft warns that it may with virtual network integration | add `export POKER_POSTGRES_SSLMODE=require` to `infra/.env.azure`, load it, repeat step 6. It still encrypts, on a network nothing else is in, without checking the certificate. Tell us |
| The same line with `ENOTFOUND` or `EAI_AGAIN` | the app cannot resolve the private DNS name | check that the zone's link to the network exists: `az network private-dns link vnet list --resource-group "$AZURE_RESOURCE_GROUP" --zone-name "$POKER_NAME.private.postgres.database.azure.com"` |
| The page loads but nobody can join a room | the address you opened is not `BASE_URL` | open exactly the address in `BASE_URL`, or fix it with `POKER_CUSTOM_DOMAIN` |
| The container is killed during start | it took longer than 600 s | read the log for why. `WEBSITES_CONTAINER_START_TIME_LIMIT` can go up to 1800 |
| `docker build` stops at `Unknown flag: mount` | the classic builder ran | update Docker, or set `DOCKER_BUILDKIT=1` |

## Removing everything

This deletes the app, the database with its backups, and the registry, and it cannot be undone:

```sh
az group delete --name "$AZURE_RESOURCE_GROUP"
```

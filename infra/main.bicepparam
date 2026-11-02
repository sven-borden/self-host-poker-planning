// The values come from the environment, so this file stays free of secrets and is committed.
// Load infra/.env.azure first (docs/07-self-hosting-azure.md). A required variable that is not set
// stops the compile. Never write a real value here: copy this to main.local.bicepparam, which git
// ignores, if you must.
using './main.bicep'

param name = readEnvironmentVariable('POKER_NAME')
param registryName = readEnvironmentVariable('POKER_REGISTRY')
param imageTag = readEnvironmentVariable('POKER_IMAGE_TAG')
param postgresPassword = readEnvironmentVariable('POKER_POSTGRES_PASSWORD')
param betterAuthSecret = readEnvironmentVariable('POKER_BETTER_AUTH_SECRET')

param planSku = readEnvironmentVariable('POKER_PLAN_SKU', 'B1')
param customDomain = readEnvironmentVariable('POKER_CUSTOM_DOMAIN', '')
param postgresServerName = readEnvironmentVariable('POKER_POSTGRES_SERVER', '${readEnvironmentVariable('POKER_NAME')}-db')
param postgresSslMode = readEnvironmentVariable('POKER_POSTGRES_SSLMODE', 'verify-full')
param extraAppSettings = json(readEnvironmentVariable('POKER_EXTRA_SETTINGS', '{}'))

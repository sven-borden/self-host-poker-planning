// Poker Planning on Azure App Service with Azure Database for PostgreSQL Flexible Server.
// docs/07-self-hosting-azure.md has the steps, ADR-032 the reasons. Deploy into a resource group
// that already holds the registry and the image. Nothing here prints a secret: the two secure
// parameters have no default, and no output carries them.

targetScope = 'resourceGroup'

@description('Azure region of everything here. The registry may sit elsewhere.')
param location string = resourceGroup().location

@description('The web app\'s name, unique across Azure. The Postgres server, the network and the plan take names from it.')
@minLength(3)
@maxLength(40)
param name string

@description('The Azure Container Registry that already holds the image, in this resource group.')
@minLength(5)
@maxLength(50)
param registryName string

@description('The tag of poker-planning in the registry. No default, so that a redeploy never rolls the image back.')
@minLength(1)
param imageTag string

@description('App Service plan tier. Free and Shared are refused: they cannot keep Always On, and without it the retention purge stops when an idle app does.')
@allowed([
  'B1'
  'B2'
  'B3'
  'S1'
  'S2'
  'S3'
  'P0v3'
  'P1v3'
  'P2v3'
  'P3v3'
])
param planSku string = 'B1'

@description('The public host name once a custom domain is bound, such as poker.example.com. Empty uses the default host name of the app.')
param customDomain string = ''

@description('The Postgres server\'s name, unique across Azure. Change it only to move to a server restored from a backup.')
@minLength(3)
@maxLength(63)
param postgresServerName string = '${name}-db'

@description('Compute of the Postgres server.')
param postgresSkuName string = 'Standard_B1ms'

@description('The tier that compute belongs to.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresTier string = 'Burstable'

@description('Size of the Postgres disk. It can grow later, never shrink.')
@minValue(32)
param postgresStorageGb int = 32

@description('Days of Flexible Server backups, which allow a restore to any point in them.')
@minValue(7)
@maxValue(35)
param postgresBackupDays int = 7

@description('verify-full checks the server\'s certificate. require only encrypts: use it if the check fails on your network.')
@allowed([
  'verify-full'
  'require'
])
param postgresSslMode string = 'verify-full'

@description('Password of the Postgres administrator: at least three of upper case, lower case, digits and symbols.')
@secure()
@minLength(16)
param postgresPassword string

@description('BETTER_AUTH_SECRET: signs the session cookies.')
@secure()
@minLength(32)
param betterAuthSecret string

@description('More app settings, such as ROOM_TTL_DAYS or GOOGLE_CLIENT_ID, by name. The settings below always win. May hold secrets, hence secure; empty adds none.')
@secure()
param extraAppSettings object = {}

var postgresAdmin = 'poker'
var databaseName = 'poker'
var port = '3000'
var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// Not the portal's privatelink zone, which is for private endpoints. It must end in
// postgres.database.azure.com and differ from the server's name.
var dnsZoneName = '${name}.private.postgres.database.azure.com'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

// A user-assigned identity exists before the site does, so AcrPull is in place before the first
// pull. A system-assigned one would get its role only after the site had tried.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-id'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRole)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRole)
  }
}

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-net'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.40.0.0/24'
      ]
    }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.40.0.0/26'
          delegations: [
            {
              name: 'app-service'
              properties: {
                serviceName: 'Microsoft.Web/serverFarms'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.0.64/28'
          delegations: [
            {
              name: 'postgres'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          // Azure adds this endpoint with the first server and warns against removing it. Listed
          // here, or a second deployment of this template would take it away.
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
    ]
  }

  resource appSubnet 'subnets' existing = {
    name: 'app'
  }

  resource postgresSubnet 'subnets' existing = {
    name: 'postgres'
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: dnsZoneName
  location: 'global'
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dnsZone
  name: '${name}-net'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.id
    }
  }
}

// Private access: no public endpoint. Only what is in this network can reach Postgres.
// 2025-08-01: Microsoft's reference for 2024-08-01 stops at version 16, and a compile would not say.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresTier
  }
  properties: {
    version: '17'
    administratorLogin: postgresAdmin
    administratorLoginPassword: postgresPassword
    storage: {
      storageSizeGB: postgresStorageGb
    }
    backup: {
      backupRetentionDays: postgresBackupDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: network::postgresSubnet.id
      privateDnsZoneArmResourceId: dnsZone.id
    }
  }
  dependsOn: [
    dnsLink
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// One instance, on purpose: more need REDIS_URL (ADR-016, README "Running several instances").
resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: '${name}-plan'
  location: location
  kind: 'linux'
  sku: {
    name: planSku
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

// No image yet: the site gets it last, in `web`, once its settings are there. Otherwise its first
// start fails on a missing DATABASE_URL and the log shows an error that means nothing.
resource site 'Microsoft.Web/sites@2024-11-01' = {
  name: name
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: true
    // Only private addresses go through the network, which is Postgres. Connectors and Sentry
    // keep the direct way out, which all-traffic routing would need a NAT gateway for.
    virtualNetworkSubnetId: network::appSubnet.id
  }
}

// A separate resource, because BASE_URL comes from the site: new sites may get a unique host
// name, not <name>.azurewebsites.net, and the server refuses a WebSocket from any other origin.
// This list replaces every app setting, so what else a site needs goes in extraAppSettings.
resource settings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: site
  name: 'appsettings'
  properties: union(extraAppSettings, {
    WEBSITES_PORT: port
    PORT: port
    WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false'
    // Past the image's pull, 30 s for Postgres, 60 s for a migration lock and the migrations.
    WEBSITES_CONTAINER_START_TIME_LIMIT: '600'
    // App Service waits 5 s by default, and the server needs up to 10 s to drain. An ack lost to a
    // kill can make a client send its command again. The same 15 s as compose.yaml.
    WEBSITES_CONTAINER_STOP_TIME_LIMIT: '15'
    BASE_URL: 'https://${empty(customDomain) ? site.properties.defaultHostName : customDomain}'
    // App Service's front end is the one proxy, and no client gets past it (ADR-032).
    TRUST_PROXY: '1'
    BETTER_AUTH_SECRET: betterAuthSecret
    DATABASE_URL: 'postgresql://${postgresAdmin}:${uriComponent(postgresPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=${postgresSslMode}'
  })
  dependsOn: [
    database
  ]
}

resource web 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: site
  name: 'web'
  properties: {
    linuxFxVersion: 'DOCKER|${registry.properties.loginServer}/poker-planning:${imageTag}'
    acrUseManagedIdentityCreds: true
    acrUserManagedIdentityID: identity.properties.clientId
    // The retention purge needs a process that stays up with nobody connected. A timer does not:
    // with no socket in the room the next arrival resolves its deadline.
    alwaysOn: true
    webSocketsEnabled: true
    // App Service ignores the image's HEALTHCHECK.
    healthCheckPath: '/api/health'
    http20Enabled: true
    minTlsVersion: '1.2'
    ftpsState: 'Disabled'
    numberOfWorkers: 1
  }
  dependsOn: [
    acrPull
    settings
  ]
}

@description('What people open.')
output baseUrl string = 'https://${empty(customDomain) ? site.properties.defaultHostName : customDomain}'

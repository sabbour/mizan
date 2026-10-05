<#
.SYNOPSIS
Creates a resource-group-scoped Mizan identity and grants its data-plane roles.
.DESCRIPTION
Run as an Azure administrator from a Mizan source checkout. The first run creates
the group and application, grants group Contributor, and saves the new secret
directly to Windows Credential Manager. After Mizan creates storage, registry,
and the worker identity, rerun with -ApplicationId and the resource names to
grant the three narrowly scoped data-plane roles. No password is printed.
#>
param(
    [Parameter(Mandatory)][guid] $SubscriptionId,
    [Parameter(Mandatory)][string] $ResourceGroup,
    [Parameter(Mandatory)][string] $Location,
    [guid] $ServiceManagementReference,
    [string] $ApplicationId,
    [switch] $IssueCredential,
    [string] $StorageAccount,
    [string] $Container,
    [string] $Registry,
    [string] $WorkerIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stageTwo = @($StorageAccount, $Container, $Registry, $WorkerIdentity)
if (@($stageTwo | Where-Object { $_ }).Count -notin @(0, 4)) {
    throw 'Supply storage account, container, registry, and worker identity together.'
}
if (-not $ApplicationId -and (-not $ServiceManagementReference -or
        $ServiceManagementReference -eq [guid]::Empty)) {
    throw 'Supply the approved Entra service-management reference to create the application.'
}
if ($stageTwo[0] -and -not $ApplicationId) {
    throw 'Rerun with the application ID from the first stage to grant resource roles.'
}
$python = Join-Path $PSScriptRoot '..\host\.venv\Scripts\python.exe'
if ((-not $ApplicationId -or $IssueCredential) -and -not (Test-Path -LiteralPath $python)) {
    throw 'Run from a source checkout with host\.venv so the secret can go straight to Windows Credential Manager.'
}
if (-not $ApplicationId -or $IssueCredential) {
    & $python -c 'import mizan.hf_credentials'
    if ($LASTEXITCODE -ne 0) {
        throw 'Install the Mizan host into host\.venv before creating a credential.'
    }
}
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Install Azure CLI and sign in as an administrator before running this script.'
}

function Invoke-Az {
    param([string[]] $Arguments)
    $output = & az @Arguments --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')"
    }
    return $output
}

function Grant-Role {
    param([string] $Principal, [string] $Role, [string] $Scope)
    $assignments = (Invoke-Az @('role', 'assignment', 'list', '--assignee-object-id',
        $Principal, '--scope', $Scope, '-o', 'json') -join "`n") | ConvertFrom-Json
    if ($assignments | Where-Object { $_.roleDefinitionName -eq $Role -and $_.scope -ieq $Scope }) {
        return
    }
    Invoke-Az @('role', 'assignment', 'create', '--assignee-object-id', $Principal,
        '--assignee-principal-type', 'ServicePrincipal', '--role', $Role, '--scope',
        $Scope, '-o', 'none') | Out-Null
}

$previousSubscription = Invoke-Az @('account', 'show', '--query', 'id', '-o', 'tsv')
try {
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId.ToString()) | Out-Null
    $tenant = Invoke-Az @('account', 'show', '--query', 'tenantId', '-o', 'tsv')
    $exists = Invoke-Az @('group', 'exists', '--name', $ResourceGroup, '-o', 'tsv')
    if ($exists -eq 'false') {
        Invoke-Az @('group', 'create', '--name', $ResourceGroup,
            '--location', $Location, '-o', 'none') | Out-Null
    } elseif ((Invoke-Az @('group', 'show', '--name', $ResourceGroup, '--query',
                'location', '-o', 'tsv')) -ne $Location) {
        throw 'The resource group already exists in a different region.'
    }
    $groupId = Invoke-Az @('group', 'show', '--name', $ResourceGroup, '--query', 'id', '-o', 'tsv')

    $created = -not $ApplicationId
    if ($created) {
        $ApplicationId = Invoke-Az @('ad', 'app', 'create', '--display-name',
            "Mizan Cloud - $ResourceGroup", '--service-management-reference',
            $ServiceManagementReference.ToString(), '--sign-in-audience',
            'AzureADMyOrg', '--query', 'appId', '-o', 'tsv')
        $principal = Invoke-Az @('ad', 'sp', 'create', '--id',
            $ApplicationId, '--query', 'id', '-o', 'tsv')
    } else {
        $principal = Invoke-Az @('ad', 'sp', 'show', '--id',
            $ApplicationId, '--query', 'id', '-o', 'tsv')
    }
    Grant-Role $principal 'Contributor' $groupId
    if ($created -or $IssueCredential) {
        $password = Invoke-Az @('ad', 'app', 'credential', 'reset', '--id',
            $ApplicationId, '--append', '--years', '1', '--query', 'password', '-o', 'tsv')
        if (-not $password) {
            throw 'Azure did not return an application credential.'
        }
        try {
            $password | & $python -c 'import sys; from mizan.hf_credentials import set_credential; set_credential("Mizan:AzureClientSecret", sys.stdin.read().rstrip("\r\n"))'
            if ($LASTEXITCODE -ne 0) {
                throw 'Could not save the application credential to Windows Credential Manager.'
            }
        } finally {
            $password = $null
        }
    }

    if ($stageTwo[0]) {
        $containerId = "$groupId/providers/Microsoft.Storage/storageAccounts/$StorageAccount/blobServices/default/containers/$Container"
        Invoke-Az @('resource', 'show', '--ids', $containerId, '--api-version',
            '2023-01-01', '--query', 'id', '-o', 'tsv') | Out-Null
        $registryId = Invoke-Az @('acr', 'show', '--resource-group', $ResourceGroup,
            '--name', $Registry, '--query', 'id', '-o', 'tsv')
        $workerPrincipal = Invoke-Az @('identity', 'show', '--resource-group',
            $ResourceGroup, '--name', $WorkerIdentity, '--query', 'principalId', '-o', 'tsv')
        Grant-Role $principal 'Storage Blob Data Contributor' $containerId
        Grant-Role $workerPrincipal 'Storage Blob Data Contributor' $containerId
        Grant-Role $workerPrincipal 'AcrPull' $registryId
    }
    [PSCustomObject]@{
        TenantId = $tenant
        ClientId = $ApplicationId
        SubscriptionId = $SubscriptionId.ToString()
        ResourceGroup = $ResourceGroup
        Credential = if ($created -or $IssueCredential) { 'Saved to Windows Credential Manager' }
                     else { 'Existing credential unchanged' }
    }
} finally {
    Invoke-Az @('account', 'set', '--subscription', $previousSubscription) | Out-Null
}

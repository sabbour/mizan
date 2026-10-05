$calls = [Collections.Generic.List[string]]::new()
function az {
    $command = $args -join ' '
    $calls.Add($command)
    $global:LASTEXITCODE = 0
    if ($command -match 'account show.*tenantId') { '99999999-9999-9999-9999-999999999999' }
    elseif ($command -match 'account show') { '11111111-1111-1111-1111-111111111111' }
    elseif ($command -match 'group exists') { 'true' }
    elseif ($command -match 'group show.*location') { 'swedencentral' }
    elseif ($command -match 'group show') {
        '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test'
    }
    elseif ($command -match 'ad sp show') { '33333333-3333-3333-3333-333333333333' }
    elseif ($command -match 'role assignment list') { '[]' }
    elseif ($command -match 'resource show') { 'container-id' }
    elseif ($command -match 'acr show') { 'registry-id' }
    elseif ($command -match 'identity show') { '44444444-4444-4444-4444-444444444444' }
}

$result = & (Join-Path $PSScriptRoot 'bootstrap-cloud.ps1') `
    -SubscriptionId 11111111-1111-1111-1111-111111111111 `
    -ResourceGroup rg-test -Location swedencentral `
    -ApplicationId 22222222-2222-2222-2222-222222222222 `
    -StorageAccount teststorage -Container jobs -Registry testacr -WorkerIdentity worker
$group = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test'
$container = "$group/providers/Microsoft.Storage/storageAccounts/teststorage/blobServices/default/containers/jobs"
$roles = @($calls | Where-Object { $_ -match '^role assignment create ' })
foreach ($expected in @(
    "33333333-3333-3333-3333-333333333333.*--role Contributor --scope $group",
    "33333333-3333-3333-3333-333333333333.*--role Storage Blob Data Contributor --scope $container",
    "44444444-4444-4444-4444-444444444444.*--role Storage Blob Data Contributor --scope $container",
    "44444444-4444-4444-4444-444444444444.*--role AcrPull --scope registry-id"
)) {
    if (@($roles | Where-Object { $_ -match $expected }).Count -ne 1) {
        throw "Missing or duplicated scoped role assignment: $expected"
    }
}
if ($roles.Count -ne 4 -or $result.ClientId -ne '22222222-2222-2222-2222-222222222222') {
    throw 'Unexpected bootstrap role or application result.'
}
'Bootstrap role scopes pass.'

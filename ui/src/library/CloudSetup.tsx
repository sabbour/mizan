import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { host, type AzureSubscription, type CloudConfig, type CloudPrepared, type CloudSetupProgress, type CloudStatus } from './bridge'
import { runWithCloudOperation, type AcquireCloudOperation, type ReleaseCloudOperation } from './cloudOperation'

type Props = {
  status: CloudStatus | null
  onStatus: (status: CloudStatus) => void
  onClose: () => void
  acquireOperation: AcquireCloudOperation
}

const defaultConfig = (subscriptionId: string): CloudConfig => {
  const suffix = subscriptionId.replaceAll('-', '').slice(0, 16).toLowerCase()
  return {
    tenantId: '',
    subscriptionId,
    resourceGroup: suffix ? `rg-mizan-${suffix}` : '',
    storageAccount: suffix ? `mizan${suffix}` : '',
    container: 'jobs',
    jobName: 'mizan-gpu-transcribe',
    location: 'swedencentral',
    registry: suffix ? `mizan${suffix}acr` : '',
    vnet: 'mizan-vnet',
    subnet: 'aca-subnet',
    vnetCidr: '10.42.0.0/16',
    subnetCidr: '10.42.0.0/23',
    subnetResourceId: '',
    environment: 'mizan-aca-env',
    identity: 'mizan-gpu-identity',
  }
}

export function CloudSetup({ status, onStatus, onClose, acquireOperation }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const activeOperation = useRef<ReleaseCloudOperation | null>(null)
  const subscriptionPicker = useRef<HTMLDetailsElement>(null)
  const subscriptionSummary = useRef<HTMLElement>(null)
  const subscriptionFilter = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState(status?.prepared || status?.workerImage ? 3 : 0)
  const [busy, setBusy] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloudSetupProgress | null>(null)
  const [approveCosts, setApproveCosts] = useState(false)
  const [approveRecovery, setApproveRecovery] = useState(false)
  const [loggingConsent, setLoggingConsent] = useState(false)
  const [jobCheckComplete, setJobCheckComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>([])
  const [subscriptionSearch, setSubscriptionSearch] = useState('')
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(true)
  const [subscriptionsLoaded, setSubscriptionsLoaded] = useState(false)
  const [prepared, setPrepared] = useState<CloudPrepared | null>(null)
  const [image, setImage] = useState(status?.workerImage ?? '')
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null)
  const [approveHfTransfer, setApproveHfTransfer] = useState(false)
  const [config, setConfig] = useState<CloudConfig>(() => ({
    ...defaultConfig(status?.config?.subscriptionId ?? ''),
    ...status?.config,
    ...status?.config && !status.prepared && !status.existingPilot && !status.workerImage
      && (!status.config.vnet || status.config.subnetResourceId)
      ? { vnet: 'mizan-vnet', subnet: 'aca-subnet', subnetResourceId: '' } : {},
    existingPilot: status?.existingPilot ?? false,
  }))
  const [networkMode, setNetworkMode] = useState(
    status?.config && (status.config.subnetResourceId || !status.config.vnet)
      && (status.prepared || status.existingPilot || status.workerImage) ? 'legacy'
      : status?.config?.subnetResourceId || (status?.config?.vnet && (
        status.config.vnet !== 'mizan-vnet' || status.config.subnet !== 'aca-subnet'
        || (status.config.vnetCidr && status.config.vnetCidr !== '10.42.0.0/16')
        || (status.config.subnetCidr && status.config.subnetCidr !== '10.42.0.0/23')))
        ? 'custom' : 'managed',
  )
  const matchingSubscriptions = subscriptions
    .filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(subscriptionSearch.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      || a.id.localeCompare(b.id))
  const selectedSubscription = subscriptions.find((item) => item.id === config.subscriptionId)
  const resumePartial = Boolean(status?.config && !status.existingPilot && !config.existingPilot && (
    ['subscriptionId', 'resourceGroup', 'storageAccount', 'container', 'jobName', 'registry', 'identity', 'environment'] as const
  ).every((key) => config[key] === status.config?.[key]))
  const recovering = Boolean(status?.workerImage && !status.prepared && !prepared && !status.existingPilot)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  useEffect(() => () => {
    activeOperation.current?.()
    activeOperation.current = null
  }, [])

  const runOperation = (phase: string, operation: (isCurrent: () => boolean) => Promise<void>) =>
    runWithCloudOperation(acquireOperation, async (release) => {
      activeOperation.current = release
      setBusy(true)
      setPhase(phase)
      setError(null)
      try {
        await operation(() => activeOperation.current === release)
      } finally {
        if (activeOperation.current === release) {
          activeOperation.current = null
          setBusy(false)
          setPhase(null)
        }
      }
    }, phase)

  const loadSubscriptions = useCallback(() =>
    host.azureSubscriptions().then((available) => {
      setSubscriptions(available)
      setSubscriptionsLoaded(true)
      setError(null)
      if (available.length === 0)
        setError('No accessible Azure subscriptions found. Sign in with an account that has an active subscription, then retry.')
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not list Azure subscriptions.')
    }).finally(() => setLoadingSubscriptions(false)), [])

  useEffect(() => {
    if ((step === 1 || step === 2) && subscriptions.length === 0)
      void loadSubscriptions()
  }, [step, subscriptions.length, loadSubscriptions])

  useEffect(() => {
    if (step !== 3 || recovering || status?.existingPilot || status?.jobCreated) return
    let active = true
    void host.hfTokenStatus().then((saved) => {
      if (active) setHfConfigured(saved)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not check your saved Hugging Face token.')
    })
    return () => { active = false }
  }, [step, recovering, status?.existingPilot, status?.jobCreated])

  useEffect(() => {
    if (step !== 1 && step !== 2) return
    const closeOutside = (event: PointerEvent) => {
      if (!subscriptionPicker.current?.contains(event.target as Node))
        subscriptionPicker.current?.removeAttribute('open')
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [step])

  useEffect(() => {
    if (!busy) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await host.cloudSetupProgress()
        if (active) setProgress(next)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not check Azure setup progress.')
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [busy])

  const refreshSubscriptions = () => {
    setLoadingSubscriptions(true)
    setError(null)
    void loadSubscriptions()
  }

  const stopWaiting = async () => {
    setCancelRequested(true)
    try {
      await host.cancelCloudSetup()
    } catch (reason) {
      setCancelRequested(false)
      setError(reason instanceof Error ? reason.message : 'Could not stop Azure setup.')
    }
  }

  const update = (key: keyof CloudConfig, value: string) => {
    setLoggingConsent(false)
    setConfig((current) => ({ ...current, [key]: value }))
  }

  const pickerKeyDown = (event: React.KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape' && subscriptionPicker.current?.open) {
      event.preventDefault()
      subscriptionPicker.current.removeAttribute('open')
      subscriptionSummary.current?.focus()
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const choices = [...(subscriptionPicker.current?.querySelectorAll<HTMLButtonElement>('.cloud-subscription-option') ?? [])]
    if (!choices.length || !subscriptionPicker.current?.open) return
    event.preventDefault()
    const current = choices.indexOf(document.activeElement as HTMLButtonElement)
    choices[event.key === 'ArrowDown'
      ? (current + 1) % choices.length
      : (current < 0 ? choices.length - 1 : (current - 1 + choices.length) % choices.length)].focus()
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    setCancelRequested(false)
    setProgress(null)
    await runOperation('Saving Azure settings…', async (isCurrent) => {
      try {
        const values = Object.fromEntries(
          Object.entries(config).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
        ) as CloudConfig
        values.resumePartial = resumePartial
        setJobCheckComplete(false)
        setApproveHfTransfer(false)
        const result = await host.configureCloud(values)
        if (!isCurrent()) return
        if (!result.config)
          throw new Error(result.issue ?? 'Azure settings were not saved.')
        onStatus(result)
        setImage(result.workerImage ?? '')
        setPhase('Provisioning Azure resources')
        const infrastructure = await host.prepareCloud(values, approveCosts)
        if (!isCurrent()) return
        setPrepared(infrastructure)
        const readyStatus = await host.cloudStatus()
        if (!isCurrent()) return
        onStatus(readyStatus)
        setImage(readyStatus.workerImage ?? '')
        setStep(3)
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Cloud setup failed.')
      }
    })
  }

  const retryEnvironment = async () => {
    const savedConfig = status?.config
    if (!savedConfig || !status.workerImage || !approveRecovery) return
    setCancelRequested(false)
    setProgress(null)
    await runOperation('Retrying Azure GPU environment…', async (isCurrent) => {
      try {
        const infrastructure = await host.prepareCloud(
          { ...savedConfig, existingPilot: false, resumePartial: true }, true)
        if (!isCurrent()) return
        setPrepared(infrastructure)
        const checked = await host.cloudStatus()
        if (!isCurrent()) return
        onStatus(checked)
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Azure GPU environment retry failed.')
      } finally {
        if (isCurrent()) setApproveRecovery(false)
      }
    })
  }

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    setProgress(null)
    const createJob = !status?.existingPilot && approveHfTransfer
    await runOperation(createJob ? 'Creating Azure GPU Job…' : 'Checking Azure setup…', async (isCurrent) => {
      try {
        const result = await host.finishCloud(image.trim(), createJob)
        if (!isCurrent()) return
        onStatus(result)
        setJobCheckComplete(Boolean(result.requiresHfTokenConsent))
        setNotice(result.next)
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Azure Job check failed.')
      } finally {
        if (isCurrent()) setApproveHfTransfer(false)
      }
    })
  }

  const checkCloudAccess = async () => {
    setNotice(null)
    setProgress(null)
    await runOperation('Checking Azure setup…', async (isCurrent) => {
      try {
        const checked = await host.cloudStatus()
        if (!isCurrent()) return
        onStatus(checked)
        setNotice(checked.configured
          ? 'Azure access and the GPU Job passed the setup checks.'
          : checked.issue ?? 'Azure access is not ready. Retry this check after resolving the issue.')
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Could not check Azure access.')
      }
    })
  }

  const connectAzureLogs = async () => {
    if (!status?.jobCreated || !loggingConsent) return
    setNotice(null)
    setProgress(null)
    await runOperation('Connecting Azure console and system logs…', async (isCurrent) => {
      try {
        const connected = await host.enableCloudLogging(true)
        if (!isCurrent()) return
        onStatus({ ...status, loggingConfigured: true, loggingLocation: connected.location })
        setNotice('Azure console and system logs are connected. This only sends new logs; it does not start a GPU Job or retrieve logs from past runs.')
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Could not connect Azure logs.')
      } finally {
        if (isCurrent()) setLoggingConsent(false)
      }
    })
  }

  const useCloud = async () => {
    if (!status?.configured) return
    setNotice(null)
    await runOperation('Enabling Cloud processing…', async (isCurrent) => {
      try {
        const mode = await host.setProcessingMode('cloud')
        if (!isCurrent()) return
        onStatus({ ...status, mode })
        setNotice('Cloud processing is on for new songs. No GPU Job or analysis was started.')
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Could not enable Cloud processing.')
      }
    })
  }

  const buildWorker = async () => {
    setNotice(null)
    setProgress(null)
    await runOperation('Building GPU worker in Azure…', async (isCurrent) => {
      try {
        const built = await host.buildCloudWorker()
        if (!isCurrent()) return
        setImage(built.image)
        const checked = await host.cloudStatus()
        if (!isCurrent()) return
        onStatus(checked)
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : 'The Azure Container Registry build failed.')
      }
    })
  }

  const subscriptionField = (
    <div className="cloud-subscription-field">
      <span id="cloud-subscription-label">Subscription</span>
      <details ref={subscriptionPicker} className="cloud-subscription-picker"
        onToggle={(event) => {
          if (event.currentTarget.open) subscriptionFilter.current?.focus()
          else setSubscriptionSearch('')
        }} onKeyDown={pickerKeyDown}>
        <summary ref={subscriptionSummary} aria-labelledby="cloud-subscription-label cloud-subscription-value">
          <span id="cloud-subscription-value"
            title={selectedSubscription ? `${selectedSubscription.name} (${selectedSubscription.id})` : undefined}>
            {selectedSubscription ? `${selectedSubscription.name} (${selectedSubscription.id})` : 'Choose a subscription'}
          </span>
        </summary>
        <div className="cloud-subscription-menu">
          <input ref={subscriptionFilter} type="search" autoComplete="off"
            aria-label="Filter subscriptions" placeholder="Filter by name or subscription ID"
            value={subscriptionSearch} onChange={(event) => setSubscriptionSearch(event.target.value)} />
          <div className="cloud-subscription-options" role="listbox" aria-label="Subscriptions">
            {matchingSubscriptions.map((item) => (
              <button key={item.id} type="button" className="cloud-subscription-option"
                role="option" aria-selected={config.subscriptionId === item.id}
                onClick={() => {
                  if (config.subscriptionId !== item.id) {
                    setApproveCosts(false)
                    setLoggingConsent(false)
                  }
                  setConfig((current) => current.subscriptionId === item.id
                    ? { ...current, tenantId: item.tenantId }
                    : { ...defaultConfig(item.id), tenantId: item.tenantId, location: current.location })
                  if (config.subscriptionId !== item.id) setNetworkMode('managed')
                  subscriptionPicker.current?.removeAttribute('open')
                  subscriptionSummary.current?.focus()
                  setError(null)
                }}>
                {item.name} <small>{item.id}</small>
              </button>
            ))}
            {matchingSubscriptions.length === 0 && <p role="status">No subscriptions match.</p>}
          </div>
        </div>
      </details>
    </div>
  )

  return (
    <dialog ref={dialog} className="cloud-dialog" aria-labelledby="cloud-title"
      onClose={onClose}
      onCancel={(event) => { if (busy) event.preventDefault() }}
      onClick={(event) => { if (!busy && event.target === event.currentTarget) event.currentTarget.close() }}>
      <div className="cloud-dialog-content" aria-busy={busy}>
        <div className="cloud-dialog-header">
          <div>
            <p className="cloud-step">Azure setup · Step {step + 1} of 4</p>
            <h2 id="cloud-title">Use your own Azure GPU</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close Azure setup" disabled={busy}
            onClick={() => dialog.current?.close()}>Close</button>
        </div>
        {step === 0 ? (
          <div className="cloud-guide">
            <p>Analyze songs on your own Azure GPU. Recordings go to your private Blob storage.</p>
            <ol>
              <li><strong>Choose</strong> an Azure subscription.</li>
              <li><strong>Approve</strong> a dedicated resource group and GPU infrastructure.</li>
              <li><strong>Build</strong> the worker and, with your approval, use your saved Hugging Face token.</li>
            </ol>
            <p className="cloud-cost-note">Azure storage, registry and GPU Jobs can cost money. Nothing is created until you approve it. Only upload recordings you have permission to use.</p>
            <details>
              <summary>Requirements and permissions</summary>
              <p>Sign in with <code>az login</code> or another supported Azure Identity credential. No app registration or client secret is needed. Your subscription needs A100 quota in the chosen region and permission to create a resource group. Assigning scoped Blob and registry roles may require an administrator.</p>
              <p>Switching back to Local stops new uploads, not a Job already running. Cloud stays Local until access and Job configuration pass preflight.</p>
            </details>
            {status?.config && status.issue && <p className="cloud-error" role="alert">{status.issue}</p>}
          </div>
        ) : step === 3 && status?.jobCreated && status.configured ? (
          <div className="cloud-guide">
            <p>{status.mode === 'cloud'
              ? 'Cloud processing is on. New songs will use the verified Azure GPU Job.'
              : 'Azure access and the manual GPU Job passed the read-only checks. Processing remains Local until you choose Use Cloud.'}</p>
            {status.warning && <p role="status">{status.warning}</p>}
            <p>This does not start a GPU Job or analyze a song.</p>
          </div>
        ) : step === 3 && status?.jobCreated ? (
          <div className="cloud-guide">
            <p>The GPU Job exists and is left unchanged. Mizan will only check its configuration and Azure access; it will not recreate the Job or transfer your Hugging Face token.</p>
            {status.issue && <p className="cloud-error" role="alert">{status.issue}</p>}
          </div>
        ) : step === 3 && recovering ? (
          <div className="cloud-guide">
            <p>Your GPU worker is already built. Azure has not finished provisioning its GPU environment, so the Job cannot be created yet. You do not need to rebuild the worker.</p>
            <p>To reuse an existing GPU Job instead, choose Change Azure settings, expand Advanced: reuse resources or change names, and select Existing pilot. Mizan will check the existing resources only after you approve the resource check below; it will not change the Job or send your Hugging Face token.</p>
            <label className="cloud-consent"><input type="checkbox" checked={approveRecovery}
              onChange={(event) => setApproveRecovery(event.target.checked)} />
              I approve retrying and completing these Azure resources, including the Log Analytics workspace, 30-day log retention and possible ingestion charges.
            </label>
          </div>
        ) : step === 3 ? (
          <form id="cloud-image-form" onSubmit={(event) => void finish(event)}>
            <p>{status?.existingPilot
              ? 'Your existing Azure resources are ready. Mizan will check and register the existing GPU Job; this will not start an analysis.'
              : image
                ? 'Your Azure resources and GPU worker are ready. Mizan will check for a matching Job before creating one.'
                : 'Your Azure resources are ready. Build the GPU worker, then create the Job that will analyze songs. Neither step starts an analysis.'}</p>
            {!status?.existingPilot && <p>Building the worker in your registry may incur Azure charges.</p>}
            {!status?.existingPilot && <button className="btn" type="button" disabled={busy}
              onClick={() => void buildWorker()}>
              {busy ? 'Building GPU worker…' : image ? 'Rebuild GPU worker' : 'Build GPU worker in my registry'}
            </button>}
            {status?.existingPilot ? (
              <>
                <p>Approved worker digest</p>
                <code>{image || 'Preparing the approved worker digest…'}</code>
                <p>Mizan checks that the existing Job image resolves to this digest in your registry. It will not change the Job or its image.</p>
              </>
            ) : (
              <p>{image ? 'GPU worker built and ready for the Job.' : 'Build the GPU worker before creating the Job.'}</p>
            )}
            {!status?.existingPilot && <>
              <p role="status">{hfConfigured === null ? 'Checking your saved Hugging Face token…'
                : hfConfigured ? 'Hugging Face token saved in Windows Credential Manager.'
                  : 'No Hugging Face token saved. Close setup, save one under Hugging Face account & access, then return.'}</p>
              {jobCheckComplete && hfConfigured && <label className="cloud-consent"><input type="checkbox" required checked={approveHfTransfer}
                onChange={(event) => setApproveHfTransfer(event.target.checked)} />
                I approve sending my saved Hugging Face token to my Azure Job.
              </label>}
              {jobCheckComplete && <p>No existing GPU Job was found. Approve token transfer only if you want Mizan to create one.</p>}
            </>}
            <details>
              <summary>Permissions and Job details</summary>
              <p>Your Azure account and Job identity need access to the private storage; the Job also needs access to your registry. If creating the Job fails because of permissions, ask an Azure administrator to grant the roles Mizan names in the error.</p>
              {prepared && <p>Job identity <code>{prepared.identityPrincipalId}</code> needs Blob Data Contributor on <code>{prepared.containerScope}</code> and AcrPull on <code>{prepared.registryScope}</code>. Your account needs Blob Data Contributor on the container.</p>}
              {status?.existingPilot
                ? <p>Mizan checks that the existing Job image resolves to the approved digest in your registry. A mismatch keeps Cloud disabled. Mizan will not change the Job or replace its Hugging Face secret.</p>
                : <p>Mizan pins the built worker image, sends the saved token only with your approval, and keeps it in Azure as a Job secret. Existing pilot Jobs must already have that secret; Mizan will not replace it.</p>}
            </details>
            <p className="cloud-setup-note" role="status">Check for an existing matching Job first. Processing stays Local until Azure access and the Job pass preflight.</p>
          </form>
        ) : (
          <form ref={form} id="cloud-setup-form" onSubmit={(event) => void save(event)}>
            {step === 1 ? (
              <>
                <p>Select the Azure subscription accessible to your desktop sign-in. If your subscription is missing, sign in with the correct account and refresh. You need permission to create a resource group and deploy resources; role assignment may require additional administrator permission.</p>
                {subscriptionField}
                <button className="btn" type="button" disabled={loadingSubscriptions}
                  onClick={refreshSubscriptions}>
                  {loadingSubscriptions ? 'Finding subscriptions…' : 'Refresh subscriptions'}
                </button>
                {loadingSubscriptions && <p role="status">Signing in and checking accessible Azure subscriptions…</p>}
                {config.subscriptionId && subscriptionsLoaded && !subscriptions.some((item) => item.id === config.subscriptionId) &&
                  <p className="cloud-error" role="alert">The saved subscription is not accessible with your current Azure sign-in. Choose another subscription.</p>}
              </>
            ) : (
              <>
                <p>Review your GPU region and resources. Nothing is created until you approve.</p>
                {subscriptionField}
                <label>GPU region
                  <select value={config.location} onChange={(event) => {
                    setConfig((current) => ({ ...current, location: event.target.value, subnetResourceId: '' }))
                    setApproveCosts(false)
                    setLoggingConsent(false)
                  }}>
                    {[
                      ['swedencentral', 'Sweden Central'], ['eastus', 'East US'],
                      ['westus', 'West US'], ['westus3', 'West US 3'],
                      ['australiaeast', 'Australia East'], ['canadacentral', 'Canada Central'],
                      ['brazilsouth', 'Brazil South'], ['italynorth', 'Italy North'],
                    ].concat(config.location && ![
                      'swedencentral', 'eastus', 'westus', 'westus3', 'australiaeast',
                      'canadacentral', 'brazilsouth', 'italynorth',
                    ].includes(config.location) ? [[config.location, config.location]] : [])
                      .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <fieldset className="cloud-network-options">
                  <legend>Virtual network</legend>
                  <label className="cloud-consent">
                    <input type="radio" name="cloud-network" checked={networkMode === 'managed'}
                      onChange={() => {
                        setNetworkMode('managed')
                        setApproveCosts(false)
                        setLoggingConsent(false)
                        setConfig((current) => ({
                          ...current, vnet: 'mizan-vnet', subnet: 'aca-subnet',
                          vnetCidr: '10.42.0.0/16', subnetCidr: '10.42.0.0/23', subnetResourceId: '',
                        }))
                      }} />
                    <span><strong>Mizan-managed VNet</strong><small>Create a VNet with Mizan's defaults.</small></span>
                  </label>
                  <label className="cloud-consent">
                    <input type="radio" name="cloud-network" checked={networkMode === 'custom'}
                      onChange={() => {
                        setNetworkMode('custom')
                        setApproveCosts(false)
                        setLoggingConsent(false)
                        setConfig((current) => ({
                          ...current, vnet: current.vnet || 'mizan-vnet',
                          subnet: current.subnet || 'aca-subnet', subnetResourceId: '',
                        }))
                      }} />
                    <span><strong>Custom VNet</strong><small>Start with defaults, then change what you need.</small></span>
                  </label>
                </fieldset>
                {networkMode === 'custom' && <>
                  <div className="cloud-network-fields">
                    <label>Virtual network name<input required autoComplete="off" value={config.vnet}
                      onChange={(event) => { update('vnet', event.target.value); setApproveCosts(false) }} /></label>
                    <label>VNet address range<input required autoComplete="off" value={config.vnetCidr}
                      onChange={(event) => { update('vnetCidr', event.target.value); setApproveCosts(false) }} /></label>
                    <label>Delegated subnet name<input required autoComplete="off" value={config.subnet}
                      onChange={(event) => { update('subnet', event.target.value); setApproveCosts(false) }} /></label>
                    <label>Subnet address range<input required autoComplete="off" value={config.subnetCidr}
                      onChange={(event) => { update('subnetCidr', event.target.value); setApproveCosts(false) }} /></label>
                  </div>
                </>}
                <div className="cloud-resource-summary">
                  <strong>What Mizan will {config.existingPilot ? 'check and reuse' : resumePartial ? 'check and complete' : 'create'}</strong>
                  <span>Subscription: {selectedSubscription?.name} ({config.subscriptionId})</span>
                  <span>Region: {config.location}; resource group: {config.resourceGroup}</span>
                  <span>Private storage: {config.storageAccount} / {config.container}</span>
                  <span>Registry: {config.registry}; GPU Job: {config.jobName}</span>
                  <span>Managed identity: {config.identity}; Container Apps environment: {config.environment}</span>
                  <span>Network: {networkMode === 'legacy' ? 'Existing network unchanged'
                    : `New VNet ${config.vnet} (${config.vnetCidr}) and delegated subnet ${config.subnet} (${config.subnetCidr})`}</span>
                </div>
                <details className="cloud-advanced">
                  <summary>Advanced: reuse resources or change names</summary>
                  <div>
                    {!status?.existingPilot && <label className="cloud-consent"><input type="checkbox" checked={config.existingPilot ?? false}
                      onChange={(event) => {
                        setApproveCosts(false)
                        setLoggingConsent(false)
                        setConfig((current) => ({ ...current, existingPilot: event.target.checked }))
                      }} />
                      Existing pilot: require all infrastructure and reuse its existing Job.
                    </label>}
                    <label>Resource group<input required autoComplete="off" value={config.resourceGroup}
                      onChange={(event) => update('resourceGroup', event.target.value)} /></label>
                    <label>Storage account<input required autoComplete="off" value={config.storageAccount}
                      onChange={(event) => update('storageAccount', event.target.value)} /></label>
                    <label>Private Blob container<input required autoComplete="off" value={config.container}
                      onChange={(event) => update('container', event.target.value)} /></label>
                    <label>Container Apps Job<input required autoComplete="off" value={config.jobName}
                      onChange={(event) => update('jobName', event.target.value)} /></label>
                    <label>Container registry name<input required autoComplete="off" value={config.registry}
                      onChange={(event) => update('registry', event.target.value)} /></label>
                    <label>Container Apps environment<input required autoComplete="off" value={config.environment}
                      onChange={(event) => update('environment', event.target.value)} /></label>
                    <label>Managed identity<input required autoComplete="off" value={config.identity}
                      onChange={(event) => update('identity', event.target.value)} /></label>
                  </div>
                </details>
                <p>Storage, registry and the environment may incur idle charges. Builds, GPU Jobs and Log Analytics ingestion are billed separately. Log Analytics keeps new console and system logs for 30 days; it does not retrieve logs from past runs. <a href="https://azure.microsoft.com/en-us/pricing/calculator/" target="_blank" rel="noreferrer">Check Azure pricing</a> before approving.</p>
                <label className="cloud-consent"><input type="checkbox" required checked={approveCosts}
                  onChange={(event) => setApproveCosts(event.target.checked)} />
                  I approve {config.existingPilot ? 'checking existing' : 'provisioning'} these Azure resources in this subscription, including possible idle and log ingestion charges with 30-day retention. This cannot be automatically undone.
                </label>
              </>
            )}
          </form>
        )}
        {step === 3 && status?.jobCreated && (
          <section className="cloud-logging" aria-labelledby="cloud-logging-title">
            <h3 id="cloud-logging-title">Azure console and system logs</h3>
            {status.loggingConfigured ? (
              <p>Connected to a workspace in {status.loggingLocation ?? 'Azure'}. Only new logs are sent; logs from past runs are not retrieved. Retention is 30 days, and Azure ingestion charges may apply.</p>
            ) : (
              <>
                <p>Mizan will create or reuse the Log Analytics workspace and connect future console and system logs. It will not change the GPU Job or retrieve logs from past runs. Retention is 30 days; Azure ingestion charges may apply.</p>
                <label className="cloud-consent">
                  <input type="checkbox" checked={loggingConsent}
                    onChange={(event) => setLoggingConsent(event.target.checked)} />
                  I approve creating or reusing the workspace and Azure log ingestion charges for this environment.
                </label>
                <button className="btn" type="button" disabled={busy || !loggingConsent}
                  onClick={() => void connectAzureLogs()}>
                  {busy ? 'Connecting Azure logs…' : 'Connect Azure logs'}
                </button>
              </>
            )}
          </section>
        )}
        {busy && <div className="cloud-setup-progress" role="status" aria-live="polite">
          <strong><span className="cloud-inline-spinner" aria-hidden="true" />
            {progress?.operation && progress.stage
              ? progress.stage.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()) : phase}</strong>
          {progress?.detail && <span>{progress.detail}</span>}
          <progress value={progress?.total && progress.total > 0 ? progress.completed : undefined}
            max={progress?.total && progress.total > 0 ? progress.total : undefined} />
          {progress && progress.total > 0 && <small>{progress.completed} of {progress.total} steps complete</small>}
        </div>}
        {busy && (phase === 'Provisioning Azure resources' || phase === 'Retrying Azure GPU environment') &&
          <button className="btn" type="button" disabled={cancelRequested} onClick={() => void stopWaiting()}>
            {cancelRequested ? 'Stopping…' : 'Stop waiting'}
          </button>}
        {error && <p className="cloud-error" role="alert">{error}</p>}
        {notice && <p className="cloud-setup-notice" role="status">{notice}</p>}
        <div className="cloud-actions">
          {step === 3 && status?.jobCreated && status.configured ? (
            status.mode === 'cloud'
              ? <button className="btn btn-primary" type="button" disabled={busy} onClick={onClose}>Done</button>
              : <>
                <button className="btn" type="button" disabled={busy} onClick={onClose}>Done</button>
                <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void useCloud()}>
                  {busy ? 'Enabling Cloud…' : 'Use Cloud'}
                </button>
              </>
          ) : (
            <>
          <button className="btn" type="button" disabled={busy}
            onClick={() => step === 0 ? dialog.current?.close() : setStep(step - 1)}>
            {step === 0 ? 'Cancel' : recovering ? 'Change Azure settings' : 'Back'}
          </button>
          {step < 2 ? (
            <button className="btn btn-primary" type="button" disabled={busy || (step === 1 && !subscriptions.some((item) => item.id === config.subscriptionId))}
              onClick={() => { if (step === 0 || form.current?.reportValidity()) { setError(null); setStep(step + 1) } }}>
              Continue
            </button>
          ) : step === 2 ? (
            <button className="btn btn-primary" type="submit" form="cloud-setup-form"
              disabled={busy || !selectedSubscription}>
              {busy ? 'Provisioning Azure…' : 'Approve and provision infrastructure'}
            </button>
          ) : recovering ? (
            <button className="btn btn-primary" type="button" disabled={busy || !approveRecovery}
              onClick={() => void retryEnvironment()}>
              {busy ? 'Retrying GPU environment…' : 'Retry GPU environment'}
            </button>
          ) : status?.jobCreated ? (
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void checkCloudAccess()}>
              {busy ? 'Checking Azure access…' : 'Retry Azure access check'}
            </button>
          ) : (
            <button className="btn btn-primary" type="submit" form="cloud-image-form"
              disabled={busy || !image || (!prepared && !status?.prepared)
                || (!status?.existingPilot && jobCheckComplete
                  && (hfConfigured !== true || !approveHfTransfer))}>
              {busy ? 'Checking Job…' : status?.existingPilot || !jobCheckComplete
                ? 'Check existing Job' : 'Create manual GPU Job'}
            </button>
          )}
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'
import { host, type AwsCloudSettings, type AzureCloudPrepared, type AzureSubscription, type CloudConfig, type CloudProvider, type CloudProviderSettingsById, type CloudReadinessProgress, type CloudSetupProgress, type CloudStatus, type CloudStatusFor, type GcpCloudSettings, type GcpProject } from './bridge'
import { runWithCloudOperation, type AcquireCloudOperation, type ReleaseCloudOperation } from './cloudOperation'

type Props = {
  provider?: CloudProvider
  status: CloudStatus | null
  onStatus: (status: CloudStatus) => void
  onClose: () => void
  acquireOperation: AcquireCloudOperation
}

export function CloudSetup(props: Props) {
  const provider = props.provider ?? props.status?.provider ?? props.status?.config?.provider ?? 'azure'
  switch (provider) {
    case 'azure': return <AzureCloudSetup {...props} status={azureStatusFor(props.status)} />
    case 'gcp': return <GcpCloudSetup {...props} />
    case 'aws': return <AwsCloudSetup {...props} />
    default:
      return (
        <dialog open aria-labelledby="cloud-provider-title">
          <h2 id="cloud-provider-title">Cloud provider unavailable</h2>
          <p>This cloud provider is not supported by this version of Mizan.</p>
          <button type="button" className="btn" onClick={props.onClose}>Close</button>
        </dialog>
      )
  }
}

function azureStatusFor(status: CloudStatus | null): CloudStatusFor<'azure'> | null {
  if (!status || status.provider && status.provider !== 'azure') return null
  const config = status.config
  if (!config) return { ...status, provider: 'azure', config: undefined }
  if (!('subscriptionId' in config)) return null
  return { ...status, provider: 'azure', config }
}

const defaultConfig = (subscriptionId: string): CloudConfig => {
  const suffix = subscriptionId.replaceAll('-', '').slice(0, 16).toLowerCase()
  return {
    provider: 'azure',
    tenantId: '',
    subscriptionId,
    resourceGroup: suffix ? `rg-mizan-${suffix}` : '',
    storageAccount: suffix ? `mizan${suffix}` : '',
    container: 'jobs',
    jobName: 'mizan-gpu-transcribe',
    location: 'swedencentral',
    registry: suffix ? `mizan${suffix}acr` : '',
    vnet: '',
    subnet: '',
    vnetCidr: '10.42.0.0/16',
    subnetCidr: '10.42.0.0/23',
    subnetResourceId: '',
    environment: 'mizan-aca-env',
    identity: 'mizan-gpu-identity',
  }
}

function AzureCloudSetup({ status, onStatus, onClose, acquireOperation }: Omit<Props, 'status'> & {
  status: CloudStatusFor<'azure'> | null
}) {
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
  const [prepared, setPrepared] = useState<AzureCloudPrepared | null>(null)
  const [image, setImage] = useState(status?.workerImage ?? '')
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null)
  const [approveHfTransfer, setApproveHfTransfer] = useState(false)
  const [config, setConfig] = useState<CloudConfig>(() => ({
    ...defaultConfig(status?.config?.subscriptionId ?? ''),
    ...status?.config,
    existingPilot: status?.existingPilot ?? false,
  }))
  const [networkMode, setNetworkMode] = useState(
    !status?.config || status.config.subnetResourceId ? 'existing'
      : !status.config.vnet ? 'legacy'
      : status.config.vnet && (
        status.config.vnet !== 'mizan-vnet' || status.config.subnet !== 'aca-subnet'
        || (status.config.vnetCidr && status.config.vnetCidr !== '10.42.0.0/16')
        || (status.config.subnetCidr && status.config.subnetCidr !== '10.42.0.0/23'))
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
    dialog.current?.showModal()
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
        const next = await host.cloudSetupProgress('azure')
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
      await host.cancelCloudSetup('azure')
    } catch (reason) {
      setCancelRequested(false)
      setError(reason instanceof Error ? reason.message : 'Could not stop Azure setup.')
    }
  }

  const update = (key: keyof CloudConfig, value: string) => {
    setApproveCosts(false)
    setApproveHfTransfer(false)
    setApproveRecovery(false)
    setJobCheckComplete(false)
    setLoggingConsent(false)
    setConfig((current) => ({ ...current, [key]: value }))
  }
  const chooseNetwork = (mode: 'existing' | 'managed') => {
    setNetworkMode(mode)
    setApproveCosts(false)
    setApproveHfTransfer(false)
    setApproveRecovery(false)
    setJobCheckComplete(false)
    setLoggingConsent(false)
    setConfig((current) => ({
      ...current,
      vnet: mode === 'existing' ? '' : 'mizan-vnet',
      subnet: mode === 'existing' ? '' : 'aca-subnet',
      vnetCidr: '10.42.0.0/16',
      subnetCidr: '10.42.0.0/23',
      subnetResourceId: mode === 'existing' && networkMode === 'existing' ? current.subnetResourceId : '',
    }))
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
        const result = await host.configureCloud(values, 'azure')
        if (!isCurrent()) return
        if (!result.config)
          throw new Error(result.issue ?? 'Azure settings were not saved.')
        onStatus(result)
        setImage(result.workerImage ?? '')
        setPhase('Provisioning Azure resources')
        const infrastructure = await host.prepareCloud(values, approveCosts, 'azure')
        if (!isCurrent()) return
        setPrepared(infrastructure)
        const readyStatus = await host.cloudStatus(undefined, 'azure')
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
          { ...savedConfig, existingPilot: false, resumePartial: true }, true, 'azure')
        if (!isCurrent()) return
        setPrepared(infrastructure)
        const checked = await host.cloudStatus(undefined, 'azure')
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
        const result = await host.finishCloud(image.trim(), createJob, 'azure')
        if (!isCurrent()) return
        onStatus(result)
        setJobCheckComplete(Boolean(result.requiresHfTokenConsent))
        setNotice(result.next ?? null)
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
        const checked = await host.cloudStatus(undefined, 'azure')
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
        const connected = await host.enableCloudLogging(true, 'azure')
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

  const enableCloudMode = async () => {
    if (!status?.configured) return
    setNotice(null)
    await runOperation('Enabling Cloud processing…', async (isCurrent) => {
      try {
        const mode = await host.setProcessingMode('cloud', 'azure')
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
        const built = await host.buildCloudWorker('azure')
        if (!isCurrent()) return
        setImage(built.image)
        const checked = await host.cloudStatus(undefined, 'azure')
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
                    setApproveHfTransfer(false)
                    setApproveRecovery(false)
                    setJobCheckComplete(false)
                    setLoggingConsent(false)
                  }
                  setConfig((current) => current.subscriptionId === item.id
                    ? { ...current, tenantId: item.tenantId }
                    : { ...defaultConfig(item.id), tenantId: item.tenantId, location: current.location })
                  if (config.subscriptionId !== item.id) setNetworkMode('existing')
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
  const advancedSettingsIncomplete = [
    config.resourceGroup, config.storageAccount, config.container, config.jobName,
    config.registry, config.environment, config.identity,
  ].some((value) => !value.trim())
  const azureStageTitles = ['Before you start', 'Choose subscription', 'Review resources', 'Build and check Job']

  return (
    <dialog ref={dialog} className="cloud-dialog" aria-labelledby="cloud-title"
      onClose={onClose}
      onCancel={(event) => { if (busy) event.preventDefault() }}
      onClick={(event) => { if (!busy && event.target === event.currentTarget) event.currentTarget.close() }}>
      <div className="cloud-dialog-content" aria-busy={busy}>
        <div className="cloud-dialog-header">
          <div>
            <p className="cloud-step">Azure setup · Step {step + 1} of 4</p>
            <progress className="cloud-stage-progress" max={4} value={step + 1} aria-label="Azure setup progress" />
            <h2 id="cloud-title">{azureStageTitles[step]}</h2>
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
          <form ref={form} id="cloud-setup-form" onSubmit={(event) => void save(event)}
            onInvalidCapture={(event) => {
              if (event.target instanceof HTMLInputElement)
                event.target.closest('details')?.setAttribute('open', '')
            }}>
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
                    setApproveHfTransfer(false)
                    setApproveRecovery(false)
                    setJobCheckComplete(false)
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
                    <input type="radio" name="cloud-network" value="existing" checked={networkMode === 'existing'}
                      onChange={() => chooseNetwork('existing')} />
                    <span><strong>Use an existing virtual network (BYO VNet)</strong><small>Mizan uses your subnet without changing it.</small></span>
                  </label>
                  <label className="cloud-consent">
                    <input type="radio" name="cloud-network" value="managed" checked={networkMode === 'managed' || networkMode === 'custom'}
                      onChange={() => chooseNetwork('managed')} />
                    <span><strong>Create a network for Mizan</strong><small>Create a separate network and subnet after your approval.</small></span>
                  </label>
                </fieldset>
                {networkMode === 'existing' && <>
                  <label>Existing subnet resource ID
                    <input name="subnetResourceId" required autoComplete="off" value={config.subnetResourceId}
                      placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Network/virtualNetworks/…/subnets/…"
                      onChange={(event) => update('subnetResourceId', event.target.value)} />
                  </label>
                  <p>Use an unused subnet in the selected subscription and GPU region. It must be delegated to <code>Microsoft.App/environments</code>. Mizan checks it before creating resources.</p>
                </>}
                {networkMode === 'legacy' && <p>Your saved Azure-managed network stays unchanged. Select an option above only to change it.</p>}
                {(networkMode === 'managed' || networkMode === 'custom') && <details className="cloud-advanced" open={networkMode === 'custom' || undefined}>
                  <summary>Change network names and address ranges</summary>
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
                </details>}
                <div className="cloud-resource-summary">
                  <strong>What Mizan will {config.existingPilot ? 'check and reuse' : resumePartial ? 'check and complete' : 'create'}</strong>
                  <span>Subscription: {selectedSubscription?.name} ({config.subscriptionId})</span>
                  <span>Region: {config.location}; resource group: {config.resourceGroup}</span>
                  <span>Private storage: {config.storageAccount} / {config.container}</span>
                  <span>Registry: {config.registry}; GPU Job: {config.jobName}</span>
                  <span>Managed identity: {config.identity}; Container Apps environment: {config.environment}</span>
                  <span>Network: {networkMode === 'existing' ? `Existing subnet ${config.subnetResourceId || '(choose a subnet)'}`
                    : networkMode === 'legacy' ? 'Saved Azure-managed network unchanged'
                    : `New VNet ${config.vnet} (${config.vnetCidr}) and delegated subnet ${config.subnet} (${config.subnetCidr})`}</span>
                </div>
                <details className="cloud-advanced" open={advancedSettingsIncomplete || undefined}>
                  <summary>Advanced: reuse resources or change names</summary>
                  <div>
                    {!status?.existingPilot && <label className="cloud-consent"><input type="checkbox" checked={config.existingPilot ?? false}
                      onChange={(event) => {
                        setApproveCosts(false)
                        setApproveHfTransfer(false)
                        setApproveRecovery(false)
                        setJobCheckComplete(false)
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
                <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void enableCloudMode()}>
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

type OtherCloudProvider = Exclude<CloudProvider, 'azure'>
type ProviderSettingsStage = 'account' | 'storage' | 'compute'
type OtherCloudSettings<P extends OtherCloudProvider> = CloudProviderSettingsById[P]
type ProviderFormProps<P extends OtherCloudProvider> = Props & {
  provider: P
  initialSettings: OtherCloudSettings<P>
  renderFields: (
    config: OtherCloudSettings<P>,
    setConfig: Dispatch<SetStateAction<OtherCloudSettings<P>>>,
    stage: ProviderSettingsStage,
  ) => ReactNode
}

const providerNames: Record<OtherCloudProvider, string> = {
  gcp: 'Google Cloud',
  aws: 'AWS',
}

const workerImageDigest = (image: string) =>
  image.trim().match(/^ghcr\.io\/[^/\s]+\/mizan-cloud-worker@(sha256:[a-f0-9]{64})$/i)?.[1] ?? null

const immutableWorkerImage = (image: string) => workerImageDigest(image) !== null

const GCP_DEFAULTS: GcpCloudSettings = {
  provider: 'gcp', location: 'us-central1', region: 'us-central1',
  machineType: 'g2-standard-8', accelerator: 'nvidia-l4',
}
const AWS_DEFAULTS: AwsCloudSettings = { provider: 'aws', profile: 'default', region: 'us-east-1' }

function GcpCloudSetup(props: Props) {
  return <ProviderCloudSetup
    {...props}
    provider="gcp"
    initialSettings={GCP_DEFAULTS}
    renderFields={(config, setConfig, stage) => renderGcpFields(config, setConfig, stage)}
  />
}

function AwsCloudSetup(props: Props) {
  return <ProviderCloudSetup
    {...props}
    provider="aws"
    initialSettings={AWS_DEFAULTS}
    renderFields={(config, setConfig, stage) => renderAwsFields(config, setConfig, stage)}
  />
}

function ProviderCloudSetup<P extends OtherCloudProvider>({
  provider, status, onStatus, onClose, acquireOperation, initialSettings, renderFields,
}: ProviderFormProps<P>) {
  const name = providerNames[provider]
  const dialog = useRef<HTMLDialogElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const activeOperation = useRef<ReleaseCloudOperation | null>(null)
  const readinessCancel = useRef<(() => void) | null>(null)
  const [config, setConfig] = useState<OtherCloudSettings<P>>(initialSettings)
  const [imageSource, setImageSource] = useState(config.image ?? status?.workerImage ?? '')
  const [verifiedImage, setVerifiedImage] = useState<string | null>(null)
  const [step, setStep] = useState<'settings' | 'resources' | 'job'>(() =>
    status?.configured && status.jobCreated || status?.prepared || status?.workerImage
      ? 'job' : status?.config ? 'resources' : 'settings')
  const [settingsStage, setSettingsStage] = useState<ProviderSettingsStage>('account')
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [progress, setProgress] = useState<CloudSetupProgress | null>(null)
  const [readinessProgress, setReadinessProgress] = useState<CloudReadinessProgress | null>(null)
  const [readinessRequest, setReadinessRequest] = useState<{ id: string; provider: P } | null>(null)
  const [approveCosts, setApproveCosts] = useState(false)
  const [jobCheckComplete, setJobCheckComplete] = useState(false)
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null)
  const [approveHfTransfer, setApproveHfTransfer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const accountSelected = provider === 'gcp'
    ? 'projectId' in config && typeof config.projectId === 'string' && !!config.projectId.trim()
    : 'accountId' in config && typeof config.accountId === 'string' && /^\d{12}$/.test(config.accountId)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => () => {
    readinessCancel.current?.()
    activeOperation.current?.()
    activeOperation.current = null
  }, [])

  useEffect(() => {
    let active = true
    void host.cloudSettings(provider).then(({ settings }) => {
      if (active) {
        setConfig({ ...initialSettings, ...settings })
        setImageSource((current) => settings.image ?? current)
        setSettingsLoading(false)
      }
    }).catch((reason: unknown) => {
      if (active) {
        setError(providerError(name, reason))
        setSettingsLoading(false)
      }
    })
    return () => { active = false }
  }, [initialSettings, name, provider])

  useEffect(() => {
    if (step !== 'job' || status?.jobCreated) return
    let active = true
    void host.hfTokenStatus().then(
      (saved) => { if (active) setHfConfigured(saved) },
      (reason: unknown) => { if (active) setError(providerError(name, reason)) },
    )
    return () => { active = false }
  }, [name, step, status?.jobCreated])

  useEffect(() => {
    if (!busy) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await host.cloudSetupProgress(provider)
        if (active) setProgress(next)
      } catch (reason) {
        if (active) setError(providerError(name, reason))
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [busy, name, provider])

  useEffect(() => {
    if (!readinessRequest) return
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await host.cloudReadinessProgress(readinessRequest.id, readinessRequest.provider)
        if (active) setReadinessProgress(next)
      } catch (reason) {
        if (active) setError(providerError(name, reason))
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 500)
    return () => { active = false; window.clearInterval(timer) }
  }, [name, readinessRequest])

  const changeConfig: Dispatch<SetStateAction<OtherCloudSettings<P>>> = (next) => {
    setConfig(next)
    setApproveCosts(false)
    setApproveHfTransfer(false)
    setVerifiedImage(null)
    setJobCheckComplete(false)
  }

  const runOperation = (label: string, operation: (isCurrent: () => boolean) => Promise<void>) =>
    runWithCloudOperation(acquireOperation, async (release) => {
      activeOperation.current = release
      setBusy(true)
      setPhase(label)
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
    }, label)

  const checkAccess = async () => {
    setNotice(null)
    setReadinessProgress(null)
    await runOperation(`Checking ${name} access…`, async (isCurrent) => {
      const id = crypto.randomUUID()
      let active = true
      setReadinessRequest({ id, provider })
      const cancel = () => {
        active = false
        setReadinessRequest(null)
        void host.cancelCloudStatus(id, provider).catch((reason: unknown) => {
          setError(providerError(name, reason))
        })
      }
      readinessCancel.current = cancel
      try {
        const checked = await host.cloudStatus(id, provider)
        if (!active || !isCurrent()) return
        onStatus(checked)
        if (checked.config) setConfig(checked.config)
        setNotice(checked.configured
          ? `${name} access is ready. No GPU job was started.`
          : checked.issue ?? `${name} access is not ready. Resolve the error, then check again.`)
      } catch (reason) {
        if (active && isCurrent()) setError(providerError(name, reason))
      } finally {
        if (readinessCancel.current === cancel) readinessCancel.current = null
        if (active) setReadinessRequest(null)
      }
    })
  }

  const cancelReadiness = () => {
    readinessCancel.current?.()
    activeOperation.current?.()
    setBusy(false)
    setPhase(null)
    setNotice(`${name} access check cancelled. No GPU job was started.`)
  }

  const stopWaiting = async () => {
    setCancelRequested(true)
    try {
      await host.cancelCloudSetup(provider)
    } catch (reason) {
      setCancelRequested(false)
      setError(providerError(name, reason))
    }
  }

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNotice(null)
    if (settingsStage === 'account' && !accountSelected) {
      setError(provider === 'gcp' ? 'Choose a Google Cloud project found through the API.'
        : 'Use Find AWS account to confirm this profile before continuing.')
      return
    }
    if (form.current && !form.current.reportValidity()) return
    if (settingsStage !== 'compute') {
      setSettingsStage(settingsStage === 'account' ? 'storage' : 'compute')
      return
    }
    await runOperation(`Saving ${name} settings…`, async (isCurrent) => {
      try {
        const settings = { ...config }
        delete settings.image
        const saved = await host.configureCloud(settings, provider)
        if (!isCurrent()) return
        if (!saved.config) throw new Error(saved.issue ?? `${name} settings were not saved.`)
        setConfig(saved.config)
        onStatus(saved)
        setStep('resources')
        setNotice(`${name} settings saved. No cloud resources were created.`)
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const previousSettingsStage = () => setSettingsStage(
    settingsStage === 'compute' ? 'storage' : 'account')

  const prepareResources = async () => {
    if (!approveCosts) return
    setCancelRequested(false)
    setProgress(null)
    await runOperation(`Preparing ${name} resources…`, async (isCurrent) => {
      try {
        const settings = { ...config }
        delete settings.image
        const result = await host.prepareCloud(settings, true, provider)
        if (!isCurrent()) return
        if (!result.prepared) throw new Error(result.next ?? `${name} resources were not prepared.`)
        const checked = await host.cloudStatus(undefined, provider)
        if (!isCurrent()) return
        onStatus(checked)
        if (checked.config) setConfig(checked.config)
        setStep('job')
        setNotice(result.next ?? `${name} resources are ready. No GPU job was started.`)
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const verifyWorkerImage = async () => {
    const sourceImage = imageSource.trim()
    const expectedDigest = workerImageDigest(sourceImage)
    if (!expectedDigest) {
      setError(`${name}: Enter a public GHCR worker image pinned to an immutable SHA-256 digest.`)
      return
    }
    setNotice(null)
    setProgress(null)
    await runOperation(`Verifying ${name} worker image…`, async (isCurrent) => {
      try {
        const imported = await host.importCloudImage(sourceImage, provider)
        if (!isCurrent()) return
        const returnedImage = imported.image.trim()
        if (imported.provider !== provider || imported.verified !== true
          || imported.digest !== expectedDigest
          || workerImageDigest(returnedImage) !== expectedDigest)
          throw new Error(`${name} did not verify the entered worker image and matching digest.`)
        const values: OtherCloudSettings<P> = { ...config, image: returnedImage }
        const saved = await host.configureCloud(values, provider)
        if (!isCurrent()) return
        if (saved.provider && saved.provider !== provider)
          throw new Error(`${name} returned settings for a different cloud provider.`)
        if (!saved.config || saved.config.image !== returnedImage)
          throw new Error(saved.issue ?? `${name} did not save the verified worker image.`)
        setConfig(saved.config)
        setImageSource(returnedImage)
        setVerifiedImage(returnedImage)
        onStatus(saved)
        setNotice(`${name} public GPU worker image was verified and saved.`)
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const checkJob = async () => {
    if (!verifiedImage || !immutableWorkerImage(verifiedImage)) {
      setError(`${name}: Verify the public immutable worker image before checking the GPU job.`)
      return
    }
    setNotice(null)
    await runOperation(`Checking ${name} GPU job…`, async (isCurrent) => {
      try {
        const checked = await host.finishCloud(verifiedImage, false, provider)
        if (!isCurrent()) return
        onStatus(checked)
        setJobCheckComplete(Boolean(checked.requiresHfTokenConsent))
        setNotice(checked.next ?? (checked.jobCreated
          ? `${name} GPU job found. Mizan did not start an analysis.`
          : `${name} access checked. No GPU job or analysis was started.`))
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const createJob = async () => {
    if (!verifiedImage || !jobCheckComplete || hfConfigured !== true || !approveHfTransfer || status?.jobCreated) return
    setNotice(null)
    await runOperation(`Creating ${name} GPU job…`, async (isCurrent) => {
      try {
        const result = await host.finishCloud(verifiedImage, true, provider)
        if (!isCurrent()) return
        onStatus(result)
        setJobCheckComplete(Boolean(result.requiresHfTokenConsent))
        setApproveHfTransfer(false)
        setNotice(result.next ?? (result.configured
          ? `${name} GPU job is ready. No analysis was started.`
          : result.issue ?? `${name} GPU job setup is not ready.`))
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const enableCloudMode = async () => {
    if (!status?.configured) return
    setNotice(null)
    await runOperation(`Enabling ${name} processing…`, async (isCurrent) => {
      try {
        const mode = await host.setProcessingMode('cloud', provider)
        if (!isCurrent()) return
        onStatus({ ...status, mode })
        setNotice(`Cloud processing is on for new songs. No GPU job or analysis was started.`)
      } catch (reason) {
        if (isCurrent()) setError(providerError(name, reason))
      }
    })
  }

  const stageTitle = step === 'settings'
    ? settingsStage === 'account' ? 'Account details'
      : settingsStage === 'storage' ? 'Private storage' : 'GPU resources'
    : step === 'resources' ? 'Review resource setup' : 'Check worker and GPU job'
  const stageNumber = step === 'settings'
    ? settingsStage === 'account' ? 1 : settingsStage === 'storage' ? 2 : 3
    : step === 'resources' ? 4 : 5

  return (
    <dialog ref={dialog} className="cloud-dialog" aria-labelledby="cloud-title"
      onClose={onClose}
      onCancel={(event) => { if (busy) event.preventDefault() }}
      onClick={(event) => { if (!busy && event.target === event.currentTarget) event.currentTarget.close() }}>
      <div className="cloud-dialog-content" aria-busy={busy}>
        <div className="cloud-dialog-header">
          <div>
            <p className="cloud-step">{name} setup · Step {stageNumber} of 5</p>
            <progress className="cloud-stage-progress" max={5} value={stageNumber} aria-label={`${name} setup progress`} />
            <h2 id="cloud-title">{stageTitle}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={`Close ${name} setup`} disabled={busy}
            onClick={() => dialog.current?.close()}>Close</button>
        </div>
        <div className="cloud-guide"><p>Mizan sends recordings to private cloud storage. Cloud resources can cost money.</p></div>
        {status?.issue && <p className="cloud-error" role="alert">{status.issue}</p>}
        {status?.warning && <p role="status">{status.warning}</p>}
        <button className="btn" type="button" disabled={busy || settingsLoading}
          onClick={() => void checkAccess()}>{busy && phase?.startsWith('Checking') ? `Checking ${name} access…` : `Check ${name} access`}</button>
        {step === 'settings' && (
          <form ref={form} id="cloud-provider-settings" onSubmit={(event) => void saveSettings(event)}>
            <p>{settingsStage === 'account' ? 'Enter your account, project, and region details.'
              : settingsStage === 'storage' ? 'Choose the private storage resources for recordings.'
                : 'Enter the GPU worker resources. Do not enter passwords, keys, or tokens.'}</p>
            {settingsLoading ? <p role="status">Loading saved {name} settings…</p> : renderFields(config, changeConfig, settingsStage)}
            <p className="cloud-setup-note">Enter a public immutable worker image after resource setup. Mizan verifies it before saving and does not create a provider registry.</p>
          </form>
        )}
        {step === 'resources' && (
          <div className="cloud-guide">
            <div className="cloud-resource-summary">
              <strong>Resources for {name}</strong>
              {Object.entries(config).filter(([key, value]) =>
                key !== 'provider' && key !== 'image' && value != null && value !== '')
                .map(([key, value]) => <span key={key}>
                  {key.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toUpperCase())}:{' '}
                  {Array.isArray(value) ? value.join(', ') : String(value)}
                </span>)}
            </div>
            <p>Readiness checks do not start GPU jobs. Disconnecting does not delete cloud resources or stop jobs.</p>
            <label className="cloud-consent"><input type="checkbox" checked={approveCosts}
              onChange={(event) => setApproveCosts(event.target.checked)} />
              I approve creating the listed resources and granting the permissions they need. Cloud charges can continue until I remove these resources.
            </label>
          </div>
        )}
        {step === 'job' && (
          status?.jobCreated && status.configured ? (
            <div className="cloud-guide">
              <p>{status.mode === 'cloud'
                ? `Cloud processing is on. New songs use your verified ${name} GPU job.`
                : `${name} access and the GPU job passed read-only checks. Processing stays Local until you choose Use Cloud.`}</p>
              <p>This does not start a GPU job or analyze a song.</p>
            </div>
          ) : (
            <div className="cloud-guide">
              {status?.jobCreated
                ? <p>The {name} GPU job exists. Mizan will not create it again or send your Hugging Face token.</p>
                : <p>Check for an existing GPU job. If Mizan must create one, it will ask before sending your saved Hugging Face token.</p>}
              <label className="cloud-image-field">Public immutable worker image
                <input name="worker-image" type="url" autoComplete="off" required
                  placeholder="ghcr.io/<owner>/mizan-cloud-worker@sha256:<digest>"
                  value={imageSource}
                  onChange={(event) => {
                    setImageSource(event.target.value)
                    setVerifiedImage(null)
                    setJobCheckComplete(false)
                    setApproveHfTransfer(false)
                    setError(null)
                    setNotice(null)
                  }} />
              </label>
              <p>Enter the public GHCR image pinned to a SHA-256 digest. Mizan checks the provider and digest before it saves the image.</p>
              {verifiedImage
                ? <p>Verified worker image: <code>{verifiedImage}</code></p>
                : <p>No public immutable worker image is verified yet.</p>}
              {!status?.jobCreated && <>
                <p role="status">{hfConfigured === null ? 'Checking your saved Hugging Face token…'
                  : hfConfigured ? 'Hugging Face token saved in Windows Credential Manager.'
                    : 'No Hugging Face token saved. Save one in Hugging Face account & access, then return.'}</p>
                {jobCheckComplete && hfConfigured && <label className="cloud-consent"><input type="checkbox" required checked={approveHfTransfer}
                  onChange={(event) => setApproveHfTransfer(event.target.checked)} />
                  I approve sending my saved Hugging Face token to my {name} GPU job.
                </label>}
              </>}
              {status?.issue && <p className="cloud-error" role="alert">{status.issue}</p>}
            </div>
          )
        )}
        {busy && <div className="cloud-setup-progress" role="status" aria-live="polite">
          <strong><span className="cloud-inline-spinner" aria-hidden="true" />{phase}</strong>
          {readinessProgress?.detail && <span>{readinessProgress.detail} ({readinessProgress.elapsedSeconds}s)</span>}
          {progress?.detail && <span>{progress.detail}</span>}
          <progress value={progress?.total && progress.total > 0 ? progress.completed : undefined}
            max={progress?.total && progress.total > 0 ? progress.total : undefined} />
          {progress && progress.total > 0 && <small>{progress.completed} of {progress.total} steps complete</small>}
        </div>}
        {busy && (phase?.startsWith('Preparing') || phase?.startsWith('Verifying')) &&
          <button className="btn" type="button" disabled={cancelRequested} onClick={() => void stopWaiting()}>
            {cancelRequested ? 'Stopping…' : 'Stop setup operation'}
          </button>}
        {busy && phase?.startsWith('Checking') && readinessRequest &&
          <button className="btn btn-quiet" type="button" onClick={cancelReadiness}>Cancel access check</button>}
        {error && <p className="cloud-error" role="alert">{error}</p>}
        {notice && <p className="cloud-setup-notice" role="status">{notice}</p>}
        <div className="cloud-actions">
          {step === 'settings' ? (
            <>
              {settingsStage !== 'compute' && <button className="btn" type="button" disabled={busy || settingsLoading}
                onClick={() => settingsStage === 'account' ? dialog.current?.close() : previousSettingsStage()}>
                {settingsStage === 'account' ? 'Cancel' : 'Back'}
              </button>}
              {settingsStage === 'compute' ? (
                <>
                  <button className="btn" type="button" disabled={busy || settingsLoading}
                    onClick={previousSettingsStage}>Back</button>
                  <button className="btn btn-primary" type="submit" form="cloud-provider-settings"
                    disabled={busy || settingsLoading}>
                    {busy ? `Saving ${name} settings…` : 'Save settings'}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary" type="submit" form="cloud-provider-settings"
                  disabled={busy || settingsLoading || settingsStage === 'account' && !accountSelected}>Continue</button>
              )}
            </>
          ) : step === 'job' && status?.jobCreated && status.configured ? (
            status.mode === 'cloud'
              ? <button className="btn btn-primary" type="button" disabled={busy} onClick={onClose}>Done</button>
              : <>
                <button className="btn" type="button" disabled={busy} onClick={onClose}>Done</button>
                <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void enableCloudMode()}>
                  {busy ? `Enabling ${name}…` : 'Use Cloud'}
                </button>
              </>
          ) : (
            <>
              <button className="btn" type="button" disabled={busy}
                onClick={() => {
                  if (step === 'job') setStep('resources')
                  else { setSettingsStage('compute'); setStep('settings') }
                }}>
                Back
              </button>
              {step === 'resources' ? (
                <button className="btn btn-primary" type="button" disabled={busy || !approveCosts}
                  onClick={() => void prepareResources()}>
                  {busy ? `Preparing ${name} resources…` : 'Approve and prepare resources'}
                </button>
              ) : !verifiedImage ? (
                <button className="btn btn-primary" type="button" disabled={busy}
                  onClick={() => void verifyWorkerImage()}>
                  {busy ? `Verifying ${name} worker image…` : 'Verify and save public GPU worker image'}
                </button>
              ) : status?.jobCreated ? (
                <button className="btn btn-primary" type="button" disabled={busy}
                  onClick={() => void checkAccess()}>{busy ? 'Checking access…' : `Retry ${name} access check`}</button>
              ) : jobCheckComplete ? (
                <button className="btn btn-primary" type="button"
                  disabled={busy || hfConfigured !== true || !approveHfTransfer}
                  onClick={() => void createJob()}>
                  {busy ? `Creating ${name} GPU job…` : `Approve token transfer and create ${name} GPU job`}
                </button>
              ) : (
                <button className="btn btn-primary" type="button" disabled={busy}
                  onClick={() => void checkJob()}>
                  {busy ? `Checking ${name} GPU job…` : 'Check existing GPU job'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

function providerError(name: string, reason: unknown) {
  return `${name}: ${reason instanceof Error ? reason.message : 'Cloud setup failed.'}`
}

function cloudTextField({ name, label, value, onChange, required = true }: {
  name: string
  label: string
  value: string | undefined
  onChange: (value: string) => void
  required?: boolean
}) {
  return <label>{label}
    <input name={name} autoComplete="off" required={required} value={value ?? ''}
      onChange={(event) => onChange(event.target.value)} />
  </label>
}

function GcpAccountFields({ config, setConfig }: {
  config: GcpCloudSettings
  setConfig: Dispatch<SetStateAction<GcpCloudSettings>>
}) {
  const [projects, setProjects] = useState<GcpProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    void host.cloudSubscriptions('gcp').then(({ subscriptions }) => {
      if (active) {
        setProjects(subscriptions)
        if (!subscriptions.length) setError('No accessible Google Cloud projects were found. Check your sign-in and permissions, then refresh.')
      }
    }).catch((reason: unknown) => {
      if (active) setError(providerError('Google Cloud', reason))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  return <>
    <label>Google Cloud project
      <select name="projectId" required disabled={loading} value={config.projectId ?? ''}
        onChange={(event) => {
          const projectId = event.target.value
          setConfig((current) => current.projectId === projectId ? current : {
            ...GCP_DEFAULTS, projectId, region: current.region || 'us-central1',
            location: current.region || 'us-central1', bucket: `mizan-${projectId}`,
            serviceAccount: `mizan-worker@${projectId}.iam.gserviceaccount.com`,
          })
        }}>
        <option value="">{loading ? 'Finding projects…' : 'Choose a project'}</option>
        {config.projectId && !projects.some((project) => project.projectId === config.projectId)
          && <option value={config.projectId}>Saved project: {config.projectId} (not found)</option>}
        {projects.map((project) => <option key={project.projectId} value={project.projectId}>
          {project.projectName} ({project.projectId})
        </option>)}
      </select>
    </label>
    <button type="button" className="btn" disabled={loading} onClick={() => {
      setLoading(true)
      setError(null)
      setRefresh((value) => value + 1)
    }}>
      {loading ? 'Finding projects…' : 'Refresh projects'}
    </button>
    <p>Projects come from the Google Cloud API using your saved sign-in. Mizan fills in resource names after you choose a project.</p>
    {error && <p className="cloud-error" role="alert">{error}</p>}
  </>
}

function AwsAccountFields({ config, setConfig }: {
  config: AwsCloudSettings
  setConfig: Dispatch<SetStateAction<AwsCloudSettings>>
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const findAccount = async () => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    setConfirmed(false)
    try {
      const { subscriptions } = await host.cloudSubscriptions('aws', config.profile, config.region)
      if (request.current !== id) return
      const account = subscriptions[0]
      if (subscriptions.length !== 1 || !account || !/^\d{12}$/.test(account.accountId)
        || account.profile !== config.profile || account.region !== config.region)
        throw new Error('AWS did not return an account for the selected profile and region.')
      setConfig((current) => {
        const defaults: AwsCloudSettings = {
          provider: 'aws', profile: account.profile, region: account.region, accountId: account.accountId,
          bucket: `mizan-${account.accountId}-${account.region}`, computeEnvironment: 'mizan-gpu',
          jobQueue: 'mizan-queue', jobDefinition: 'mizan-worker', role: 'mizan-job-role',
        }
        return current.accountId === account.accountId ? { ...defaults, ...current } : defaults
      })
      setConfirmed(true)
    } catch (reason) {
      if (request.current === id) setError(providerError('AWS', reason))
    } finally {
      if (request.current === id) setLoading(false)
    }
  }
  const change = (key: 'profile' | 'region', value: string) => {
    setConfirmed(false)
    setError(null)
    setConfig((current) => ({ ...current, [key]: value, accountId: '' }))
  }
  return <>
    <label>AWS credential profile
      <input name="profile" required disabled={loading} autoComplete="off" value={config.profile ?? ''}
        onChange={(event) => change('profile', event.target.value)} />
    </label>
    <label>GPU region
      <input name="region" required disabled={loading} autoComplete="off" value={config.region ?? ''}
        onChange={(event) => change('region', event.target.value)} />
    </label>
    <button type="button" className="btn" disabled={loading || !config.profile?.trim() || !config.region?.trim()}
      onClick={() => void findAccount()}>{loading ? 'Finding AWS account…' : 'Find AWS account'}</button>
    <label>AWS account ID
      <input name="accountId" required readOnly value={config.accountId ?? ''} />
    </label>
    <p role="status">{confirmed ? `AWS confirmed account ${config.accountId}.`
      : 'Mizan uses the AWS API to find your account and fill in resource names. No resources are created by this check.'}</p>
    {error && <p className="cloud-error" role="alert">{error}</p>}
  </>
}

function renderGcpFields(
  config: GcpCloudSettings,
  setConfig: Dispatch<SetStateAction<GcpCloudSettings>>,
  stage: ProviderSettingsStage,
) {
  return <div className="cloud-network-fields">
    {stage === 'account' && <>
    <GcpAccountFields config={config} setConfig={setConfig} />
    {cloudTextField({ name: 'region', label: 'GPU region', value: config.region,
      onChange: (region) => setConfig((current) => ({ ...current, region, location: region })) })}
    </>}
    {stage === 'storage' && <>
    {cloudTextField({ name: 'bucket', label: 'Private storage bucket', value: config.bucket,
      onChange: (bucket) => setConfig((current) => ({ ...current, bucket })) })}
    {cloudTextField({ name: 'serviceAccount', label: 'Job service account', value: config.serviceAccount,
      onChange: (serviceAccount) => setConfig((current) => ({ ...current, serviceAccount })) })}
    </>}
    {stage === 'compute' && <>
    {cloudTextField({ name: 'machineType', label: 'GPU machine type', value: config.machineType,
      onChange: (machineType) => setConfig((current) => ({ ...current, machineType })) })}
    {cloudTextField({ name: 'accelerator', label: 'GPU accelerator', value: config.accelerator,
      onChange: (accelerator) => setConfig((current) => ({ ...current, accelerator })) })}
    </>}
  </div>
}

function renderAwsFields(
  config: AwsCloudSettings,
  setConfig: Dispatch<SetStateAction<AwsCloudSettings>>,
  stage: ProviderSettingsStage,
) {
  return <div className="cloud-network-fields">
    {stage === 'account' && <>
    <AwsAccountFields config={config} setConfig={setConfig} />
    </>}
    {stage === 'storage' && <>
    {cloudTextField({ name: 'bucket', label: 'Private S3 bucket', value: config.bucket,
      onChange: (bucket) => setConfig((current) => ({ ...current, bucket })) })}
    </>}
    {stage === 'compute' && <>
    {cloudTextField({ name: 'computeEnvironment', label: 'GPU compute environment', value: config.computeEnvironment,
      onChange: (computeEnvironment) => setConfig((current) => ({ ...current, computeEnvironment })) })}
    {cloudTextField({ name: 'jobQueue', label: 'Batch job queue', value: config.jobQueue,
      onChange: (jobQueue) => setConfig((current) => ({ ...current, jobQueue })) })}
    {cloudTextField({ name: 'jobDefinition', label: 'Batch job definition', value: config.jobDefinition,
      onChange: (jobDefinition) => setConfig((current) => ({ ...current, jobDefinition })) })}
    {cloudTextField({ name: 'role', label: 'Job role', value: config.role,
      onChange: (role) => setConfig((current) => ({ ...current, role })) })}
    <details className="cloud-advanced-fields">
      <summary>Advanced network settings</summary>
    {cloudTextField({ name: 'subnetIds', label: 'Subnet IDs (optional), separated by commas', value: config.subnetIds?.join(', '),
      required: false,
      onChange: (value) => setConfig((current) => ({ ...current, subnetIds: splitResourceIds(value) })) })}
    {cloudTextField({ name: 'securityGroupIds', label: 'Security group IDs (optional), separated by commas', value: config.securityGroupIds?.join(', '),
      required: false,
      onChange: (value) => setConfig((current) => ({ ...current, securityGroupIds: splitResourceIds(value) })) })}
    </details>
    </>}
  </div>
}

function splitResourceIds(value: string) {
  const ids = value.split(',').map((part) => part.trim()).filter(Boolean)
  return ids.length ? ids : undefined
}

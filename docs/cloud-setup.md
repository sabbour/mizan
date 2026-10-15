# Cloud setup

Mizan processes jobs on the local computer by default. You can select one
cloud provider for new jobs. Cloud processing sends recording audio to
resources in an account that you own.

## Prepare account access

Mizan does not install provider CLIs or sign in for you. Set up your saved
sign-in outside Mizan, under the same Windows account that runs Mizan. Do not
enter passwords, access keys, or provider tokens in Mizan. A CLI is optional
when Mizan already has a working supported sign-in.

- **Azure:** Mizan uses your saved local Azure sign-in, not your browser
  sign-in. Sign in with Azure CLI or an already configured supported tool such
  as Azure PowerShell. The CLI is optional if that tool is already set up.
  Install
  [Azure CLI for Windows](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows)
  if needed, then verify and sign in:

  ```powershell
  az --version
  az login
  ```

- **Google Cloud:** Mizan needs a saved application login called Application
  Default Credentials (ADC) for this Windows account. Browser sign-in and
  `gcloud auth login` alone do not set this up. The
  [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) is optional
  when another supported ADC source is already configured. If ADC is missing,
  verify and create it under Mizan's Windows account:

  ```powershell
  gcloud --version
  gcloud auth application-default login
  ```

  Then select **Refresh projects** in Mizan.

- **AWS:** Mizan uses the AWS profile you enter, not your browser sign-in.
  Other saved credential types supported by the AWS SDK remain available; AWS
  CLI is optional if the selected profile already works. `aws configure`
  remains an option for a basic profile. For IAM Identity Center, install
  [AWS CLI v2 for Windows](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
  verify the CLI, then configure and sign in to the profile you will enter in
  Mizan. These commands use `mizan` as a simple example; replace it with your
  profile name:

  ```powershell
  aws --version
  aws configure sso --profile "mizan"
  aws sso login --profile "mizan"
  ```

If PowerShell says `az`, `gcloud`, or `aws` is not recognized, the CLI is
missing or its `PATH` is not set; this is not a cloud sign-in failure. Install
the CLI, or use its installer to add the installed CLI's `bin` directory to
`PATH`, then open a **new PowerShell window** and verify the corresponding
`--version` command. Run CLI sign-in commands and Mizan as the same Windows
user so they use the intended local credentials.

Google Cloud project discovery uses ADC to list active projects visible to
that credential. It is separate from **Check Google Cloud access**, which is
a readiness check and does not list projects or create resources. If the list
is empty, check project membership and refresh.

## Provider resources and limits

Azure keeps the existing Container Apps GPU Jobs, Blob Storage, and Azure
Container Registry path. Select an active, billing-enabled subscription and a
region offered by Mizan with available A100 quota and capacity. Subscription
access must allow resource creation; scoped role assignments may require an
administrator.
The setup fields include `subscriptionId`, `location`, `resourceGroup`,
`storageAccount`, `container`, `jobName`, `registry`, `environment`, and
`identity`. The first network choice uses an existing virtual network
(BYO VNet). Enter its subnet resource ID. The subnet must be unused, in the
selected subscription and GPU region, and delegated to
`Microsoft.App/environments`. Mizan checks the subnet before resource
creation and does not change the network or subnet.

To create a separate network, select **Create a network for Mizan**.
You can change `vnet`, `subnet`, `vnetCidr`, and `subnetCidr` in
**Change network names and address ranges**. Saved network settings keep
their current choice. Mizan
gets the tenant ID from the selected subscription. It builds the worker in
your registry. Do not use the shared image procedure for Azure.

Google Cloud uses Batch and Cloud Storage. Choose an active project visible to
ADC with billing enabled; project listing requires access to view the project.
For setup, the account also needs access to use the selected project's required
APIs and resources; ask an administrator if Mizan reports denied access.
Enter `projectId`, `location`,
`region`, `bucket`, `serviceAccount`, `machineType`, and `accelerator`.
`location` and `region` must match. Mizan supports G2 L4 machines only:
`g2-standard-4` with `nvidia-l4` supports Small and Medium.
`g2-standard-8` with `nvidia-l4` supports Small, Medium, and Large.
Choose a region that offers the selected machine and has the required GPU
quota and capacity. Use a private bucket and a service account in the selected
project. Cost approval remains separate from credentials and project discovery.

AWS uses Batch on managed EC2 GPU instances and S3. The selected profile must
identify the intended active, billing-enabled AWS account; Mizan confirms the
identity through STS. Approved setup needs access to the selected region's
Batch, EC2, S3, IAM, and network resources; an administrator may need to grant
that access. AWS Fargate is not supported. Enter `profile`, `region`,
`accountId`, `bucket`,
`computeEnvironment`, `jobQueue`, `jobDefinition`, and `role`. Mizan supports
`g5.4xlarge` only. Its Batch compute environment must use managed EC2 and that
instance type. The region must offer this instance and have enough GPU quota
and capacity.
Use a private S3 bucket. Set both `subnetIds` and `securityGroupIds`, or leave
both empty so approved setup can create a private worker network.

Mizan returns provider resource IDs and secret version references after setup.
These are read-only values. Do not enter them as credentials.

## Start setup in Mizan

Google Cloud setup uses authenticated REST API requests. AWS setup uses
the `boto3` SDK. Mizan does not run a cloud CLI to create resources.
Account and project checks do not create resources.

For Google Cloud or AWS, use this procedure:

1. In **Library**, open **Song analysis**.
2. Open **Analysis processing**.
3. Select a **Cloud provider**.
4. Select **Cloud** or the setup action for that provider.
5. For Google Cloud, choose a project found through the API. Review the region.
6. For AWS, enter the credential profile and region. Select **Find AWS account** to confirm the account through STS.
7. Select **Continue**. Review the suggested storage and GPU resource names. You can change them before saving. AWS network IDs are optional under **Advanced network settings**.
8. Select **Save settings**. Mizan saves non-secret references but does not create resources.
9. Review the resource summary and provider prices.
10. Select **Approve and prepare resources** to create the listed resources and permissions.
11. If the shared image has no confirmed public reference, stop setup here.
12. Do not enter the placeholder as a working image reference.
13. After publication, enter the complete public image reference with its digest.
14. Select **Verify and save public GPU worker image**.
15. Select **Check existing GPU job**.
16. If Mizan needs to create job setup, approve the token transfer with **Approve token transfer and create `<provider>` GPU job**.
17. Run the read-only provider access check.
18. After the check passes, select **Use Cloud** to send new jobs to that provider.

The token-transfer action creates or registers cloud job setup. It does not
start a GPU analysis. Readiness checks also do not start GPU jobs. An analysis
starts only when you submit a song.

An approved token transfer sends a copy of your saved Hugging Face token to
the provider's secret service. The original token remains in Windows
Credential Manager. Mizan records only non-secret resource and secret-version
references in settings and job details.

The Azure wizard keeps the existing Container Apps GPU Job path:

1. In **Library**, open **Song analysis**.
2. Open **Analysis processing** and select **Azure** as the cloud provider.
3. Open its setup action.
4. Select the subscription and GPU region.
5. Enter the existing subnet resource ID, or select **Create a network for Mizan**.
6. Review the resources and charges.
7. Approve resource creation.
8. Select **Approve and provision infrastructure**.
9. Select **Build GPU worker in my registry**.
10. Select **Check existing Job**.
11. If no matching Job exists, approve the separate token transfer.
12. If no matching Job exists, select **Create manual GPU Job**.
13. After the access check passes, select **Use Cloud**.

The wizard builds the worker in your Azure registry. It does not require the
shared GHCR image. Job creation does not start an analysis.

## Shared image for Google Cloud and AWS

The shared Linux AMD64 CUDA image has no confirmed public owner or digest yet.
The format `ghcr.io/<owner>/mizan-cloud-worker@sha256:<digest>` is a
placeholder. It is not a working image reference.

The owner publishes the image with the manual
[cloud worker workflow](cloud-worker-image.md). The workflow records the
immutable image reference, digest, and source hash. The first package
publication is private. The owner must make only this package public and
check anonymous access. Do not replace the digest with a tag.

The worker application code uses the MIT License. PyTorch, NumPy, and SciPy
have BSD terms. Google authentication libraries have Apache terms. The CUDA
base image and other dependencies have separate terms. Review and preserve
their notices. The image has no model weights, credentials, tokens, or
recordings. The worker downloads pinned model files at runtime and checks
their hashes. MuScriptor checkpoints have noncommercial terms and stay outside
the image.

## Capacity and test limits

Model availability uses the selected resource's capacity. It does not prove
that a model will finish or produce accurate notes.

| Resource | Available model sizes |
|---|---|
| Google Cloud `g2-standard-4`, 4 vCPU, 16 GiB RAM, L4 | Small and Medium |
| Google Cloud `g2-standard-8`, 8 vCPU, 32 GiB RAM, L4 | Small, Medium, and Large |
| AWS `g5.4xlarge`, 16 vCPU, 64 GiB RAM, A10G | Small, Medium, and Large |
| Existing Azure GPU Job | Sizes allowed by the existing Azure resource checks |

The historical Azure A100 pilot completed a real Small-model run at 2 vCPU
and 8 GiB RAM, including host import and library save. An eight-second
synthetic Small-model run used 4 vCPU and 16 GiB RAM and took 166 seconds.
A separate synthetic Large-model run used 2 vCPU and 8 GiB RAM and took
230 seconds. The Large run did not test the full host pipeline. Medium and
the full Large host path have not completed live GPU validation. A T4 pilot
stopped before its container started. Its cause remains unknown. These
historical results do not prove current customer setup or real-song accuracy.

The new provider paths have offline tests. Those tests do not verify live
account access, region quota, or resource setup. Optional live cloud tests
need separate user approval and can incur charges.

## Costs and data

Cloud setup and jobs can cost money for GPU time, storage, network traffic,
registry storage, and image builds. AWS compute minimum and desired vCPUs
start at zero. Storage and network charges can still apply. Mizan does not
select a provider by price, use spot instances, or switch providers as a
fallback.

Each queued job keeps the selected provider and non-secret resource targets.
The host records the remote job ID before it checks job status. Changing
providers does not redirect, cancel, or clean up an existing job.

Mizan downloads bounded result files, validates them, and saves all six
separation stems to the local library. It removes remote result files after
the job reports success and the local save completes. After a confirmed
failure or cancellation, Mizan cleans up the known files. If submission or
stop status is unknown, Mizan retains remote files for investigation. It does
not retry an unknown submission automatically.

Disconnect forgets the selected provider settings and returns new jobs to
Local processing. It does not delete cloud resources or stop existing jobs.
Other saved provider profiles remain available. Use the provider console to
manage or delete resources. Your Hugging Face token remains in Windows
Credential Manager after disconnect.

Readiness checks show access and resource state. They do not start GPU
jobs. A readiness result can become stale if you change permissions or
resources in the provider console.

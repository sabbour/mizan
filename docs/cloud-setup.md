# Cloud setup

Mizan processes jobs on the local computer by default. You can select one
cloud provider for new jobs. Cloud processing sends recording audio to
resources in an account that you own.

## Prepare account access

Set up each provider's command-line credentials before you enter its resource
settings. Do not enter passwords, access keys, or provider tokens in Mizan.

Prepare access for each provider before setup:

- **Azure:** Install Azure CLI. Run `az login`. Use a subscription with A100 quota in a supported region. Other Azure Identity credentials also work.
- **Google Cloud:** Install Google Cloud CLI. Run `gcloud auth application-default login`. `gcloud auth login` alone does not set up Application Default Credentials for Mizan.
- **AWS:** Install AWS CLI. Create or sign in to a named profile outside Mizan. Use `aws configure sso` or `aws configure`.

Google Cloud uses the
configured Application Default Credentials. AWS uses the selected profile and
region through `boto3.Session`. Keep these credentials in their local provider
tools.

## Provider resources and limits

Azure keeps the existing Container Apps GPU Jobs, Blob Storage, and Azure
Container Registry path. Select a subscription and an A100-supported region.
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

Google Cloud uses Batch and Cloud Storage. Enter `projectId`, `location`,
`region`, `bucket`, `serviceAccount`, `machineType`, and `accelerator`.
`location` and `region` must match. Mizan supports G2 L4 machines only:
`g2-standard-4` with `nvidia-l4` supports Small and Medium.
`g2-standard-8` with `nvidia-l4` supports Small, Medium, and Large.
Choose a region that offers the selected machine and has the required GPU
quota. Use a private bucket and a service account in the selected project.

AWS uses Batch on managed EC2 GPU instances and S3. AWS Fargate is not
supported. Enter `profile`, `region`, `accountId`, `bucket`,
`computeEnvironment`, `jobQueue`, `jobDefinition`, and `role`. Mizan supports
`g5.4xlarge` only. Its Batch compute environment must use managed EC2 and that
instance type. The region must offer this instance and have enough capacity.
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

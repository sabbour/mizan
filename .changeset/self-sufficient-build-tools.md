---
"mizan": patch
---

Make the local setup, build, and signing scripts find their own tools. A new `Initialize-HostEnvironment.ps1` creates the host environment with the matching Python 3.12 and your pip configuration. `Publish-SignedMsix.ps1 -Build` builds with the active signing profile's publisher and signs that exact package, finding the Trusted Signing client through the configured NuGet packages folder.

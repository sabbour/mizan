export type ReleaseCloudOperation = () => void
export type AcquireCloudOperation = (label?: string) => ReleaseCloudOperation | null

export function createCloudOperationGate() {
  let active: symbol | null = null

  return {
    acquire(): ReleaseCloudOperation | null {
      if (active) return null
      const token = Symbol()
      active = token
      let released = false
      return () => {
        if (released) return
        released = true
        if (active === token) active = null
      }
    },
    isLocked: () => active !== null,
  }
}

export async function runWithCloudOperation<T>(
  acquire: AcquireCloudOperation,
  operation: (release: ReleaseCloudOperation) => Promise<T>,
  label?: string,
): Promise<T | undefined> {
  const release = acquire(label)
  if (!release) return undefined
  try {
    return await operation(release)
  } finally {
    release()
  }
}

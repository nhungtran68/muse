export interface RetentionClaim {
  job_id: string;
  user_id: string;
  final_path: string;
  reference_path: string;
  scene_paths: Array<{ scene_index: number; path: string }>;
  retention_attempt: number;
  retention_claim_token: string;
}

export interface StorageRemover {
  remove(bucket: string, paths: string[]): Promise<{ error: unknown | null }>;
  list?(bucket: string, path: string, search: string): Promise<{
    data: Array<{ name: string }> | null;
    error: unknown | null;
  }>;
}

export interface DeleteResult {
  ok: boolean;
  failures: Array<{ bucket: string; error: unknown }>;
}

function isSafeJobPath(path: string, prefix: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || !path.startsWith(prefix)) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/**
 * Removes only paths owned by this exact user/job. Calls one bucket at a time
 * so a failure in one bucket does not prevent cleanup in the other. Retrying
 * the same call is safe: successful object removals are idempotent.
 */
export async function deleteJobOutputs(
  storage: StorageRemover,
  job: RetentionClaim,
): Promise<DeleteResult> {
  const ownerPrefix = `${job.user_id}/${job.job_id}/`;
  const videoPaths = [...new Set([
    job.final_path,
    ...job.scene_paths.map((scene) => scene.path),
  ].filter((path): path is string => Boolean(path)))];
  const referencePaths = [job.reference_path];

  if (
    !videoPaths.every((path) => isSafeJobPath(path, ownerPrefix)) ||
    referencePaths.length !== 1 ||
    referencePaths[0] !== `${ownerPrefix}reference` ||
    !referencePaths.every((path) => isSafeJobPath(path, `${ownerPrefix}reference`))
  ) {
    return { ok: false, failures: [{ bucket: "validation", error: new Error("Job contains an out-of-scope Storage path") }] };
  }

  const failures: DeleteResult["failures"] = [];
  for (const [bucket, paths] of [
    ["brand-videos", videoPaths],
    ["brand-references", referencePaths],
  ] as const) {
    if (!paths.length) continue;
    try {
      let pathsToRemove = paths;
      if (storage.list) {
        pathsToRemove = [];
        for (const objectPath of paths) {
          const separator = objectPath.lastIndexOf("/");
          const directory = objectPath.slice(0, separator);
          const filename = objectPath.slice(separator + 1);
          const { data, error } = await storage.list(bucket, directory, filename);
          if (error) failures.push({ bucket, error });
          else if (data?.some((file) => file.name === filename)) pathsToRemove.push(objectPath);
          // An object already missing from Storage is a successful prior delete.
        }
      }

      if (pathsToRemove.length) {
        const { error } = await storage.remove(bucket, pathsToRemove);
        if (error) failures.push({ bucket, error });
      }
    } catch (error) {
      failures.push({ bucket, error });
    }
  }

  return { ok: failures.length === 0, failures };
}

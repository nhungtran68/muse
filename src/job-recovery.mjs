export function hasUncertainSubmission(job) {
  return job?.status === 'error'
    && (['SUBMISSION_NOT_FOUND','MUSE_TIMEOUT'].includes(job.error_code)
      || (job.error_code === 'UNCERTAIN_SUBMISSION' && String(job.error || '').includes('Không tìm thấy yêu cầu cảnh')))
    && Array.isArray(job.brand_scenes)
    && job.brand_scenes.some(scene =>
      ['generating', 'error'].includes(scene.status)
      && ['sending','sent'].includes(scene.submission_state)
      && Boolean(scene.request_receipt)
      && !scene.output_path
    );
}

export function visibleSceneStatus(job, scene) {
  if (hasUncertainSubmission(job)
    && ['sending','sent'].includes(scene?.submission_state)
    && scene?.request_receipt
    && !scene?.output_path
    && scene.status === 'generating') return 'error';
  return scene?.status || 'waiting';
}

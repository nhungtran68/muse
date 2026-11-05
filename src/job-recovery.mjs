export function hasUncertainSubmission(job) {
  return job?.status === 'error'
    && (job.error_code === 'SUBMISSION_NOT_FOUND'
      || (job.error_code === 'UNCERTAIN_SUBMISSION' && String(job.error || '').includes('Không tìm thấy yêu cầu cảnh')))
    && Array.isArray(job.brand_scenes)
    && job.brand_scenes.some(scene =>
      ['generating', 'error'].includes(scene.status)
      && scene.submission_state === 'sending'
      && Boolean(scene.request_receipt)
      && !scene.output_path
    );
}

export function visibleSceneStatus(job, scene) {
  if (hasUncertainSubmission(job)
    && scene?.submission_state === 'sending'
    && scene?.request_receipt
    && !scene?.output_path
    && scene.status === 'generating') return 'error';
  return scene?.status || 'waiting';
}

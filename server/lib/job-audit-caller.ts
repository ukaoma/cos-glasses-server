// 6.97.0: the token-audit caller of a dispatched task or a meeting review, which read as `full_query`
// before. Routines have their own (routines-config.ts). Import-free, so the review runtime can mark a
// job without loading the job runtime.

/** Review jobs in this process. A review resumed after a restart reads as an ordinary query again. */
const workReviewJobs = new Set<string>()
const WORK_REVIEW_JOBS_MAX = 256

/** Reviews carry no origin (a new kind would reach the phone and COS Control), so they are marked here. */
export function noteWorkReviewJob(clientJobId: string): void {
  workReviewJobs.delete(clientJobId)
  workReviewJobs.add(clientJobId)
  if (workReviewJobs.size > WORK_REVIEW_JOBS_MAX) workReviewJobs.delete(workReviewJobs.values().next().value!)
}

/** '' for every other job, whose caller stays what the bridge picks. */
export function jobAuditCaller(request: { clientJobId?: string; origin?: { kind: string } }): string {
  if (request.origin?.kind === 'task') return 'dispatch_task'
  return request.clientJobId && workReviewJobs.has(request.clientJobId) ? 'work_review' : ''
}

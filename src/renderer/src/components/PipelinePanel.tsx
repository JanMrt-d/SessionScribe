import {
  Ban,
  Check,
  Circle,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X
} from 'lucide-react'
import type { Job } from '@shared/domain'
import { jobStageLabel } from '../lib/format'
import { Button, InlineNotice } from './ui'

const STAGES: Job['stage'][] = [
  'probe',
  'playback-proxy',
  'extract-audio',
  'transcribe',
  'diarize',
  'summarize'
]

interface PipelinePanelProps {
  jobs: Job[]
  onRetry(jobId: string): Promise<void>
  onCancel(jobId: string): Promise<void>
}

export function PipelinePanel({
  jobs,
  onRetry,
  onCancel
}: PipelinePanelProps): React.JSX.Element | null {
  if (jobs.length === 0) return null

  const jobsByMostRecent = [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const runningJob = jobsByMostRecent.find((job) => job.status === 'running')
  const queuedJob = [...jobs]
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  const activeJob = runningJob ?? queuedJob
  const displayJob = activeJob ?? jobsByMostRecent[0]
  const displayStageIndex = displayJob ? STAGES.indexOf(displayJob.stage) : -1
  const failedJobs = displayJob?.status === 'failed' ? [displayJob] : []

  return (
    <section className="pipeline-panel" aria-labelledby="pipeline-title">
      <header>
        <div>
          <span className="eyebrow">Processing pipeline</span>
          <h2 id="pipeline-title">
            {activeJob
              ? `${jobStageLabel(activeJob.stage)}${activeJob.status === 'queued' ? ' queued' : ''}`
              : failedJobs.length > 0
                ? 'Processing paused'
                : displayJob?.status === 'cancelled'
                  ? 'Processing cancelled'
                  : 'Processing complete'}
          </h2>
        </div>
        {activeJob ? (
          <Button size="small" variant="ghost" onClick={() => void onCancel(activeJob.id)}>
            <X size={15} /> Cancel
          </Button>
        ) : null}
      </header>

      <ol className="pipeline-stages">
        {STAGES.map((stage) => {
          const stageIndex = STAGES.indexOf(stage)
          const job = displayJob?.stage === stage ? displayJob : undefined
          const inferredComplete = displayStageIndex > stageIndex
          const status = inferredComplete ? 'succeeded' : job?.status
          return (
            <li className={status ? `is-${status}` : ''} key={stage}>
              <JobIcon status={status} />
              <div>
                <strong>{jobStageLabel(stage)}</strong>
                <span>{inferredComplete ? 'Complete' : job ? jobStatus(job) : 'Waiting'}</span>
              </div>
              {job?.status === 'running' ? (
                <div
                  className="stage-progress"
                  aria-label={`${Math.round(job.progress * 100)} percent`}
                >
                  <i style={{ width: `${job.progress * 100}%` }} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>

      {failedJobs.map((job) => (
        <InlineNotice
          tone="danger"
          icon={<CircleAlert size={18} />}
          actions={
            <Button size="small" onClick={() => void onRetry(job.id)}>
              <RotateCcw size={15} /> Retry
            </Button>
          }
          key={job.id}
        >
          <strong>{jobStageLabel(job.stage)} failed</strong>
          <span>{job.errorMessage ?? job.errorCode ?? 'No error details were provided.'}</span>
        </InlineNotice>
      ))}
    </section>
  )
}

function JobIcon({ status }: { status: Job['status'] | undefined }): React.JSX.Element {
  if (!status) return <Circle size={18} />
  if (status === 'succeeded') return <Check size={18} />
  if (status === 'running') return <LoaderCircle className="spin" size={18} />
  if (status === 'queued') return <RefreshCw size={18} />
  if (status === 'failed') return <CircleAlert size={18} />
  if (status === 'cancelled') return <Ban size={18} />
  return <Circle size={18} />
}

function jobStatus(job: Job): string {
  switch (job.status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return `${Math.round(job.progress * 100)}% complete`
    case 'succeeded':
      return 'Complete'
    case 'failed':
      return `Attempt ${Math.max(1, job.attempt)} failed`
    case 'cancelled':
      return 'Cancelled'
  }
}

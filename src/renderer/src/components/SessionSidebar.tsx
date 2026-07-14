import { useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  BookOpenText,
  CalendarDays,
  ChevronRight,
  Mic2,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload
} from 'lucide-react'
import type { Session } from '@shared/domain'
import type { ManagedWhisperStatus } from '@shared/whisper'
import { formatDate, formatDuration, statusLabel } from '../lib/format'
import { Button, IconButton } from './ui'
import { WhisperStatusCard, type WhisperAction } from './WhisperStatusCard'

interface SessionSidebarProps {
  sessions: Session[]
  selectedId: string | null
  activeSessionId: string | null
  version: string
  whisperStatus: ManagedWhisperStatus | null
  whisperAction: WhisperAction
  onSelect(id: string): void
  onCreate(): void
  onImport(): void
  onDelete(id: string): void
  onOpenSettings(): void
  onInstallWhisper(): Promise<void>
  onCancelWhisperInstall(): Promise<void>
  onStartWhisper(): Promise<void>
  onStopWhisper(): Promise<void>
}

export function SessionSidebar({
  sessions,
  selectedId,
  activeSessionId,
  version,
  whisperStatus,
  whisperAction,
  onSelect,
  onCreate,
  onImport,
  onDelete,
  onOpenSettings,
  onInstallWhisper,
  onCancelWhisperInstall,
  onStartWhisper,
  onStopWhisper
}: SessionSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return sessions
    return sessions.filter((session) => session.title.toLocaleLowerCase().includes(normalized))
  }, [query, sessions])

  return (
    <aside className="sidebar" aria-label="Session library">
      <header className="sidebar__brand">
        <div className="brand-mark" aria-hidden="true">
          <Mic2 size={19} strokeWidth={2.3} />
        </div>
        <div>
          <strong>SessionScribe</strong>
          <span>Local meeting notes</span>
        </div>
      </header>

      <div className="sidebar__actions">
        <Button variant="primary" onClick={onCreate}>
          <Plus size={17} />
          New recording
        </Button>
        <IconButton label="Import recording" onClick={onImport}>
          <Upload size={17} />
        </IconButton>
      </div>

      <label className="search-field">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search sessions</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
        />
      </label>

      <div className="sidebar__section-label">
        <span>Sessions</span>
        <span>{filteredSessions.length}</span>
      </div>

      <nav className="session-list" aria-label="Recorded sessions">
        {filteredSessions.length === 0 ? (
          <div className="session-list__empty">
            <CalendarDays size={20} />
            <span>{sessions.length === 0 ? 'No sessions yet' : 'No matching sessions'}</span>
          </div>
        ) : (
          filteredSessions.map((session) => {
            const selected = session.id === selectedId
            const active = session.id === activeSessionId || session.status === 'recording'
            return (
              <div className={`session-row ${selected ? 'is-selected' : ''}`} key={session.id}>
                <button className="session-row__main" onClick={() => onSelect(session.id)}>
                  <span
                    className={`session-row__mode session-row__mode--${session.preferredMode}`}
                    aria-hidden="true"
                  >
                    {session.preferredMode === 'meeting' ? (
                      <Mic2 size={16} />
                    ) : (
                      <BookOpenText size={16} />
                    )}
                  </span>
                  <span className="session-row__content">
                    <span className="session-row__title">{session.title}</span>
                    <span className="session-row__meta">
                      {active ? <i className="recording-dot" /> : null}
                      {active ? 'Recording' : formatDate(session.updatedAt)}
                      {session.durationMs ? ` · ${formatDuration(session.durationMs)}` : ''}
                    </span>
                  </span>
                  {session.status === 'failed' || session.status === 'interrupted' ? (
                    <span
                      className="status-pin status-pin--danger"
                      title={statusLabel(session.status)}
                    />
                  ) : null}
                  {selected ? <ChevronRight size={15} aria-hidden="true" /> : null}
                </button>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton label={`Actions for ${session.title}`} variant="ghost">
                      <MoreHorizontal size={16} />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="end">
                      <DropdownMenu.Item
                        className="dropdown-item dropdown-item--danger"
                        disabled={active}
                        onSelect={() => onDelete(session.id)}
                      >
                        <Trash2 size={15} />
                        Delete session
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            )
          })
        )}
      </nav>

      <WhisperStatusCard
        status={whisperStatus}
        action={whisperAction}
        compact
        onInstall={onInstallWhisper}
        onCancelInstall={onCancelWhisperInstall}
        onStart={onStartWhisper}
        onStop={onStopWhisper}
      />

      <footer className="sidebar__footer">
        <button onClick={onOpenSettings}>
          <Settings size={17} />
          <span>Settings</span>
        </button>
        <span>v{version}</span>
      </footer>
    </aside>
  )
}

import { useEffect, useState } from 'react'

type Project = { id: string; name: string; desc: string; progress: number; due: string; tasks: number }

const PROJECTS: Project[] = [
  { id: 'atlas', name: 'Atlas redesign', desc: 'New marketing site and docs', progress: 72, due: 'Due Mar 14', tasks: 18 },
  { id: 'harbor', name: 'Harbor API', desc: 'Public REST API v2', progress: 45, due: 'Due Apr 2', tasks: 26 },
  { id: 'lumen', name: 'Lumen mobile', desc: 'iOS and Android apps', progress: 30, due: 'Due May 20', tasks: 41 },
]
const TASKS = ['Audit current pages', 'Write new homepage copy', 'Design component library', 'Build pricing page', 'Launch checklist']

function useRoute() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-2 rounded-full bg-line overflow-hidden">
      <div className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />
    </div>
  )
}

function Header({ section }: { section: string }) {
  const link = (href: string, label: string, key: string) => (
    <a href={href} className={`px-3.5 py-2 rounded-full font-medium no-underline ${section === key ? 'bg-accent-soft text-accent' : 'text-muted'}`}>
      {label}
    </a>
  )
  return (
    <header className="h-16 flex items-center gap-8 px-10 bg-surface border-b border-line">
      <div className="flex items-center gap-2.5 text-[18px] leading-[1.45] font-bold">
        <span className="w-[26px] h-[26px] rounded-lg bg-accent inline-block" />
        Acme
      </div>
      <nav className="flex gap-1.5">
        {link('#/', 'Projects', 'projects')}
        {link('#/activity', 'Activity', 'activity')}
        {link('#/settings', 'Settings', 'settings')}
      </nav>
      <div className="ml-auto w-[34px] h-[34px] rounded-full bg-[#c7d2fe]" />
    </header>
  )
}

function Projects() {
  return (
    <>
      <h1 className="text-[28px] font-bold tracking-tight m-0 mb-1.5">Projects</h1>
      <p className="text-muted m-0 mb-7">3 active projects · updated 5 minutes ago</p>
      <div className="grid grid-cols-3 gap-6">
        {PROJECTS.map((p) => (
          <a key={p.id} href={`#/project/${p.id}`} data-testid={`project-${p.id}`} className="block no-underline text-ink bg-surface border border-line rounded-[14px] p-[22px] hover:shadow-[0_6px_24px_rgba(20,24,38,.08)] transition-shadow">
            <h3 className="text-[18px] leading-[1.45] font-bold m-0 mb-1.5">{p.name}</h3>
            <p className="text-muted m-0 mb-[18px]">{p.desc}</p>
            <Bar value={p.progress} />
            <div className="flex justify-between mt-2.5 text-[13px] text-muted">
              <span>{p.progress}% complete</span>
              <span>{p.due}</span>
            </div>
          </a>
        ))}
      </div>
    </>
  )
}

function ProjectDetail({ id }: { id: string }) {
  const p = PROJECTS.find((x) => x.id === id) ?? PROJECTS[0]
  return (
    <>
      <span className="inline-block px-2.5 py-[3px] rounded-full bg-accent-soft text-accent text-[12px] leading-[1.45] font-semibold mb-3.5">In progress</span>
      <h1 className="text-[28px] font-bold tracking-tight m-0 mb-1.5">{p.name}</h1>
      <p className="text-muted m-0 mb-7">{p.desc} · {p.tasks} tasks</p>
      <div className="grid grid-cols-[2fr_1fr] gap-6">
        <div className="bg-surface border border-line rounded-[14px] px-[22px] py-2">
          {TASKS.map((t, i) => (
            <div key={t} className="flex items-center gap-3.5 py-3.5 border-b border-line last:border-b-0">
              <div className={`w-5 h-5 rounded-md border-2 ${i < 2 ? 'bg-done border-done' : 'border-line'}`} />
              <span className={i < 2 ? 'text-muted line-through' : ''}>{t}</span>
            </div>
          ))}
        </div>
        <div className="bg-surface border border-line rounded-[14px] p-[22px]">
          <small className="text-muted text-[13px]">Progress</small>
          <div className="text-[34px] font-bold">{p.progress}%</div>
          <div className="mt-3"><Bar value={p.progress} /></div>
          <p className="text-muted mt-3.5 mb-0">{p.due}</p>
        </div>
      </div>
    </>
  )
}

function Toggle({ initial, id }: { initial: boolean; id?: string }) {
  const [on, setOn] = useState(initial)
  return (
    <button
      id={id}
      aria-pressed={on}
      onClick={() => setOn(!on)}
      className={`relative w-[46px] h-[26px] rounded-full border-0 cursor-pointer transition-colors duration-[250ms] ease-in-out ${on ? 'bg-accent' : 'bg-[#cbd2e1]'}`}
    >
      <span className={`absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-white transition-transform duration-[250ms] ease-in-out ${on ? 'translate-x-5' : ''}`} />
    </button>
  )
}

function Settings() {
  const rows: Array<[string, string, boolean, string?]> = [
    ['Email digests', 'A summary of activity every morning', true],
    ['Mentions', 'Notify me when someone mentions me', false, 'mentions'],
    ['Weekly report', 'Send project progress every Friday', true],
  ]
  return (
    <>
      <h1 className="text-[28px] font-bold tracking-tight m-0 mb-1.5">Settings</h1>
      <p className="text-muted m-0 mb-7">Manage notifications and workspace preferences</p>
      <div className="bg-surface border border-line rounded-[14px] px-[22px] py-2 max-w-[640px]">
        {rows.map(([title, sub, on, id]) => (
          <div key={title} className="flex items-center justify-between py-[18px] border-b border-line last:border-b-0">
            <div>
              <b className="block">{title}</b>
              <small className="text-muted text-[13px]">{sub}</small>
            </div>
            <Toggle initial={on} id={id} />
          </div>
        ))}
      </div>
      <button className="mt-[22px] bg-accent text-white border-0 px-5 py-3 rounded-[10px] font-semibold text-[15px] leading-[normal] cursor-pointer">Save changes</button>
    </>
  )
}

export default function App() {
  const route = useRoute()
  const section = route.startsWith('/settings') ? 'settings' : route.startsWith('/activity') ? 'activity' : 'projects'
  let page = <Projects />
  if (route.startsWith('/project/')) page = <ProjectDetail id={route.split('/')[2]} />
  else if (route === '/settings') page = <Settings />
  else if (route === '/activity') page = <><h1 className="text-[28px] font-bold m-0 mb-1.5">Activity</h1><p className="text-muted">Nothing new today</p></>
  return (
    <>
      <Header section={section} />
      <main className="px-10 py-9 max-w-[1200px]">
        <div key={route} className="page-enter">{page}</div>
      </main>
    </>
  )
}

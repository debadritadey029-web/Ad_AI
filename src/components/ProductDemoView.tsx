import React, { useMemo, useState } from 'react';
import { PlayCircle, ChevronLeft, ChevronRight, ShieldCheck, Megaphone, Palette, BarChart3, Sparkles, Users, Wallet, CheckCircle2 } from 'lucide-react';

const chapters = [
  { title: 'Connect your channels', icon: Users, time: '0:00–0:25', text: 'Choose the organization workspace, connect an advertising account through the authorized provider flow, and review the requested permissions.', tasks: ['Select the organization', 'Connect an authorized provider account', 'Confirm access and account scope'], boundary: 'Provider connection requires configured OAuth credentials and provider approval.' },
  { title: 'Plan a campaign', icon: Megaphone, time: '0:25–0:55', text: 'Create a draft, choose an objective, set budget and schedule, and review targeting before any launch decision.', tasks: ['Choose a channel and objective', 'Set budget, dates and audience', 'Review the draft before submission'], boundary: 'Drafting does not publish live ads. Provider-side publishing remains gated until integrations are verified.' },
  { title: 'Prepare creative assets', icon: Palette, time: '0:55–1:20', text: 'Prepare channel-specific copy and creative variants, review brand safety, and route assets to a human reviewer.', tasks: ['Prepare headline and copy', 'Check channel formats', 'Review brand safety and policy'], boundary: 'Review AI-generated content for accuracy, rights, policy compliance and brand suitability.' },
  { title: 'Review budgets safely', icon: Wallet, time: '1:20–1:50', text: 'Submit a justified budget proposal and route it to an independent authorized approver for four-eyes review.', tasks: ['Submit a reasoned proposal', 'Check budget limits and version', 'Approve or reject independently'], boundary: 'The current demo does not execute live provider-side budget changes. Use staging data only.' },
  { title: 'Measure and optimize', icon: BarChart3, time: '1:50–2:15', text: 'Review performance, ask the AI copilot for insights, manage leads, and inspect team permissions and governance events.', tasks: ['Review channel performance', 'Ask the AI copilot for analysis', 'Inspect team roles and audit history'], boundary: 'Metrics depend on configured integrations. Clearly distinguish demo data from live provider data.' },
];

function safeVideoUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1);
      return id ? { type: 'embed' as const, src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') {
      const id = url.searchParams.get('v');
      return id ? { type: 'embed' as const, src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (url.hostname === 'vimeo.com' || url.hostname === 'www.vimeo.com') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && /^\d+$/.test(id) ? { type: 'embed' as const, src: `https://player.vimeo.com/video/${id}` } : null;
    }
    if (url.hostname === 'player.vimeo.com' && url.pathname.startsWith('/video/')) return { type: 'embed' as const, src: url.href };
    if (url.pathname.toLowerCase().endsWith('.mp4') && !url.username && !url.password) return { type: 'mp4' as const, src: url.href };
    return null;
  } catch { return null; }
}

export const ProductDemoView: React.FC = () => {
  const [index, setIndex] = useState(0);
  const video = useMemo(() => safeVideoUrl(import.meta.env.VITE_PRODUCT_DEMO_VIDEO_URL || ''), []);
  const chapter = chapters[index];
  const Icon = chapter.icon;
  const move = (next: number) => setIndex(Math.max(0, Math.min(chapters.length - 1, next)));

  return <div className="space-y-6">
    <header className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-indigo-950/60 p-6 sm:p-8">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.18em] text-blue-300"><PlayCircle className="h-4 w-4" /> Product walkthrough · approx. 2 minutes</div>
      <h1 className="mt-3 text-2xl font-black text-white sm:text-3xl">See how AdVantage AI works</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">A guided end-to-end tour of channel setup, campaign planning, creative review, financial governance and performance analysis.</p>
    </header>

    <section className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4"><h2 className="text-sm font-bold text-white">Product demo</h2><p className="mt-1 text-xs text-slate-400">{video ? 'Published video' : 'Interactive walkthrough'}</p></div>
        {video ? <div className="aspect-video bg-black">{video.type === 'mp4' ? <video className="h-full w-full" controls preload="metadata" playsInline><source src={video.src} type="video/mp4" />Your browser does not support embedded video.</video> : <iframe className="h-full w-full" src={video.src} title="AdVantage AI product demonstration" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />}</div> :
          <div className="relative flex aspect-video flex-col items-center justify-center overflow-hidden bg-slate-950 p-6 text-center">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-950/70 via-slate-950 to-slate-950" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-400/30 bg-blue-500/10 text-blue-300"><Icon className="h-8 w-8" /></div>
            <p className="relative mt-4 text-[10px] font-bold uppercase tracking-[.18em] text-blue-300">Chapter {index + 1} · {chapter.time}</p>
            <h3 className="relative mt-2 max-w-lg text-xl font-black text-white">{chapter.title}</h3>
            <p className="relative mt-2 max-w-lg text-xs leading-5 text-slate-400">Use the guided chapters to walk customers through the product while a narrated recording is prepared.</p>
            <div className="relative mt-5 flex gap-2">{chapters.map((item, i) => <button key={item.title} type="button" onClick={() => move(i)} aria-label={`Go to chapter ${i + 1}`} className={`h-1.5 rounded-full ${i === index ? 'w-9 bg-blue-400' : 'w-4 bg-slate-700 hover:bg-slate-500'}`} />)}</div>
          </div>}
        <div className="flex items-center justify-between gap-3 border-t border-slate-800 p-4">
          <button type="button" onClick={() => move(index - 1)} disabled={index === 0} className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /> Previous</button>
          <span className="text-[11px] text-slate-500">Chapter {index + 1} of {chapters.length}</span>
          <button type="button" onClick={() => move(index + 1)} disabled={index === chapters.length - 1} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-40">Next <ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
        <div className="flex items-start gap-3"><div className="rounded-xl bg-blue-500/10 p-3 text-blue-300"><Icon className="h-5 w-5" /></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-blue-300">Step {index + 1}</p><h2 className="mt-1 text-lg font-black text-white">{chapter.title}</h2><p className="mt-3 text-xs leading-6 text-slate-300">{chapter.text}</p></div></div>
        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-400">What the customer does</h3>
        <ol className="mt-3 space-y-3">{chapter.tasks.map((task, i) => <li key={task} className="flex items-start gap-3 text-xs text-slate-200"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-blue-300">{i + 1}</span><span className="pt-0.5">{task}</span></li>)}</ol>
        <div className="mt-6 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5"><div className="flex items-center gap-2 text-[11px] font-bold text-amber-300"><ShieldCheck className="h-4 w-4" /> Important product boundary</div><p className="mt-2 text-[11px] leading-5 text-slate-400">{chapter.boundary}</p></div>
      </div>
    </section>

    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
      <div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-400" /><h2 className="text-sm font-bold text-white">The end-to-end workflow</h2></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{chapters.map((item, i) => { const ChapterIcon = item.icon; return <button key={item.title} type="button" onClick={() => move(i)} className={`rounded-xl border p-4 text-left transition ${i === index ? 'border-blue-500/60 bg-blue-500/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-600'}`}><div className="flex items-center justify-between"><ChapterIcon className={`h-5 w-5 ${i === index ? 'text-blue-300' : 'text-slate-400'}`} /><span className="text-[10px] text-slate-500">{String(i + 1).padStart(2, '0')}</span></div><h3 className="mt-3 text-xs font-bold text-white">{item.title}</h3><p className="mt-2 text-[10px] text-slate-400">{item.time}</p></button>; })}</div>
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" /><p className="text-xs leading-5 text-slate-400">To publish your recorded demo, set <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200">VITE_PRODUCT_DEMO_VIDEO_URL</code> in Vercel to an HTTPS MP4, YouTube or Vimeo URL, then redeploy. Use demo data only—never expose credentials, tokens, or real customer account details.</p></div>
    </section>
  </div>;
};

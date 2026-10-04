import { useState } from 'react';
import { twMerge, twJoin } from 'tailwind-merge';
import { cn } from './utils.ts';
import { buttonVariants, badgeVariants, type ButtonVariant, type ButtonSize } from './variants.ts';

type Tone = 'warm' | 'cool' | null;

const nextVariant = (v: ButtonVariant): ButtonVariant =>
  v === 'solid' ? 'outline' : v === 'outline' ? 'ghost' : 'solid';
const nextSize = (s: ButtonSize): ButtonSize =>
  s === undefined ? 'sm' : s === 'sm' ? 'lg' : s === 'lg' ? 'md' : undefined;
const nextTone = (t: Tone): Tone => (t === null ? 'warm' : t === 'warm' ? 'cool' : null);

export function App() {
  const [variant, setVariant] = useState<ButtonVariant>('solid');
  const [size, setSize] = useState<ButtonSize>(undefined);
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<Tone>(null);
  const [override, setOverride] = useState<ButtonVariant | ''>('');
  const [filter, setFilter] = useState<'all' | 'open'>('all');

  return (
    <main>
      <h1 id="title" className={twMerge('title text-base', 'text-lg')}>
        Tailwind packs
      </h1>
      <div className="row">
        <button id="variant" className={cn(buttonVariants({ variant, size }), 'w-28')} onClick={() => setVariant(nextVariant(variant))}>
          Variant
        </button>
        <button id="size" className={cn(buttonVariants({ variant: 'outline', size }), 'w-28')} onClick={() => setSize(nextSize(size))}>
          Size
        </button>
        <button id="active" className={cn('btn w-28 border px-4 py-2', active && 'bg-green px-6', open ? 'py-1' : 'py-3')} onClick={() => setActive(!active)}>
          Active
        </button>
        <button id="open" className={buttonVariants({ variant: filter === 'all' ? 'ghost' : 'outline', size: 'sm', class: 'w-28' })} onClick={() => setOpen(!open)}>
          Open
        </button>
        <button id="tone" className={cn(buttonVariants({ variant: 'ghost', size: 'sm', class: 'px-8 rounded-none' }), 'w-28')} onClick={() => setTone(nextTone(tone))}>
          Tone
        </button>
        <button id="override" className={cn(buttonVariants({ variant: override || variant, size: 'sm' }), 'w-28')} onClick={() => setOverride(override === '' ? 'ghost' : '')}>
          Override
        </button>
        <button id="filter" className={twMerge('btn w-28 border px-2 py-1', filter === 'open' && 'bg-blue text-white')} onClick={() => setFilter(filter === 'all' ? 'open' : 'all')}>
          Filter
        </button>
      </div>
      <div className="row">
        <span id="badge" className={badgeVariants({ active, tone })}>
          Badge
        </span>
        <span id="badge-const" className={badgeVariants({ tone: 'cool', class: 'px-4' })}>
          Const
        </span>
        <span id="group" className={cn('group py-1', open && 'flex flex-col py-2')}>
          Group
        </span>
        <span id="list" className={cn(['item px-2', active && 'px-3'], { 'text-blue': open, 'font-bold': !open })}>
          List
        </span>
      </div>
      <p>
        <code id="v-variant">{cn(buttonVariants({ variant, size }), 'w-28')}</code>
      </p>
      <p>
        <code id="v-badge">{badgeVariants({ active, tone })}</code>
      </p>
      <p>
        <code id="v-join">{twJoin('p-2', active && 'p-4', tone)}</code>
      </p>
      <p>
        <code id="v-const">{twMerge('p-2 text-sm', 'p-4 font-bold', ['px-1', 'shadow-md shadow-inner'])}</code>
      </p>
    </main>
  );
}

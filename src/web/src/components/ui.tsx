import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react';

/**
 * Hand-built primitives instead of a component library.
 *
 * There are about a dozen of them and they never introduce a breaking upstream
 * change, which matters more here than breadth: this deployment is maintained a
 * few hours a quarter.
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variantClass: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

export function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium
        transition-colors disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2
        focus-visible:ring-teal-500 focus-visible:ring-offset-1 ${variantClass[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

const controlClass = `w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm
  focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500
  disabled:bg-slate-100 disabled:text-slate-500`;

// React 19 delivers `ref` to a function component as an ordinary prop, so no
// forwardRef wrapper is needed - but the prop type has to say so, and spreading
// it onto the DOM element is what actually wires it up. The POS depends on this
// to move focus between fields without the operator touching the mouse.
export function Input({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={`${controlClass} ${className}`} />;
}

export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select {...props} className={`${controlClass} ${className}`}>
      {children}
    </select>
  );
}

export function Card({ title, actions, children, className = '' }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
          {typeof title === 'string' ? <h2 className="font-semibold text-slate-800">{title}</h2> : title}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone = 'default' }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    default: 'text-slate-900',
    good: 'text-teal-700',
    warn: 'text-amber-600',
    bad: 'text-red-600',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`tnum mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' }) {
  const toneClass = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-teal-100 text-teal-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  }[tone];
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${toneClass}`}>{children}</span>;
}

/** Wide tables scroll inside their own container; the page never scrolls sideways. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4">{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>;
}

type Align = 'left' | 'right' | 'center';

// Written out in full rather than interpolated. Tailwind generates CSS by
// scanning source for literal class names, so `text-${align}` would produce a
// class that never exists in the stylesheet.
const alignClass: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function Th({ children, align = 'left' }: { children?: ReactNode; align?: Align }) {
  return (
    <th
      className={`border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase
        tracking-wide text-slate-500 ${alignClass[align]}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', className = '' }: {
  children?: ReactNode;
  align?: Align;
  className?: string;
}) {
  return <td className={`border-b border-slate-100 px-3 py-2 ${alignClass[align]} ${className}`}>{children}</td>;
}

export function EmptyState({ message }: { message: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{message}</p>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600" />
      {label}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const toneClass = {
    info: 'bg-slate-50 text-slate-700 border-slate-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    error: 'bg-red-50 text-red-700 border-red-200',
    success: 'bg-teal-50 text-teal-800 border-teal-200',
  }[tone];
  return <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>{children}</div>;
}

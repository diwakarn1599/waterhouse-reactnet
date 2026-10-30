import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../state/session';

const navItems: Array<{ to: string; label: string; adminOnly?: boolean; primary?: boolean }> = [
  { to: '/', label: 'Dashboard' },
  { to: '/sell', label: 'Sell', primary: true },
  { to: '/sales', label: 'Sales' },
  { to: '/payments', label: 'Payments' },
  { to: '/customers', label: 'Customers' },
  { to: '/stock', label: 'Stock' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/reports', label: 'Reports' },
  { to: '/admin', label: 'Admin', adminOnly: true },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, data, signOut, online, queued } = useSession();
  const items = navItems.filter((item) => !item.adminOnly || user?.role === 'admin');

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2">
          <div className="font-semibold text-teal-800">{data?.branch.name ?? 'Waterhouse'}</div>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => {
                  // Sell is styled as the primary action even when inactive.
                  // The dashboard is the landing page now, so the route to the
                  // till has to be the most obvious thing in the bar.
                  if (item.primary) {
                    return `rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${
                      isActive ? 'bg-teal-700 text-white' : 'bg-teal-600 text-white hover:bg-teal-700'
                    }`;
                  }
                  return `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100'
                  }`;
                }}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            <ConnectionPill online={online} queued={queued} />
            <span className="hidden text-slate-500 sm:inline">{user?.displayName}</span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">{children}</main>
    </div>
  );
}

/**
 * Connection state is shown permanently rather than as a transient toast.
 * An operator needs to know at a glance whether takings are still queued on
 * this device, especially at the end of a shift.
 */
function ConnectionPill({ online, queued }: { online: boolean; queued: number }) {
  if (!online) {
    return (
      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
        Offline{queued > 0 ? ` · ${queued} queued` : ''}
      </span>
    );
  }
  if (queued > 0) {
    return (
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
        Syncing {queued}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-800">Online</span>
  );
}

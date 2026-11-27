import type { ComponentPropsWithoutRef } from 'react';
import { Icon } from './Icon';

export function LinkAction({ children, icon = 'arrow', className = '', ...button }: ComponentPropsWithoutRef<'button'> & {
  icon?: 'arrow' | 'back' | 'external';
}) {
  return <button {...button} type="button" className={`text-button link-action ${className}`} data-link-icon={icon}>
    <span>{children}</span><Icon name={icon === 'external' ? 'arrow' : icon} size={12} />
  </button>;
}

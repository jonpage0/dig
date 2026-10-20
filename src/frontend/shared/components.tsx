import * as React from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cn } from './utils';

export function Button({ className, variant = 'default', size = 'default', ...props }: React.ComponentProps<typeof BaseButton> & {
  variant?: 'default' | 'outline' | 'ghost'; size?: 'default' | 'sm' | 'icon';
}) {
  return <BaseButton {...props} className={cn('dig-button', `dig-button-${variant}`, `dig-button-size-${size}`, className)} />;
}
export function Card({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card" className={cn('dig-card', className)} />; }
export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card-header" className={cn('dig-card-header', className)} />; }
export function CardTitle({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card-title" className={cn('dig-card-title', className)} />; }
export function CardDescription({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card-description" className={cn('dig-card-description', className)} />; }
export function CardContent({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card-content" className={cn('dig-card-content', className)} />; }
export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) { return <div {...props} data-slot="card-footer" className={cn('dig-card-footer', className)} />; }
export function Badge({ tone = 'neutral', className, ...props }: React.ComponentProps<'span'> & { tone?: 'neutral' | 'success' | 'partial' | 'warning' | 'muted' }) {
  return <span {...props} data-tone={tone} className={cn('dig-badge', className)} />;
}
export function Disclosure({ title, children, defaultOpen = false, open, onOpenChange, className }: {
  title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string;
}) {
  return <Collapsible.Root defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} className={cn('dig-disclosure', className)}>
    <Collapsible.Trigger className="dig-disclosure-trigger"><span>{title}</span><span aria-hidden="true" className="dig-chevron">⌄</span></Collapsible.Trigger>
    <Collapsible.Panel className="dig-disclosure-panel">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}
export function Dialog({ open, onOpenChange, title, description, children, footer }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="dig-dialog-backdrop" />
      <BaseDialog.Popup className="dig-dialog">
        <div className="dig-dialog-header">
          <div><BaseDialog.Title className="dig-dialog-title">{title}</BaseDialog.Title>{description && <BaseDialog.Description className="dig-card-description">{description}</BaseDialog.Description>}</div>
          <BaseDialog.Close className="dig-button dig-button-ghost dig-button-size-sm" aria-label="Close dialog">Close</BaseDialog.Close>
        </div>
        <div className="dig-dialog-body">{children}</div>
        {footer && <div className="dig-dialog-footer">{footer}</div>}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>;
}
export const Tabs = BaseTabs.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof BaseTabs.List>) { return <BaseTabs.List {...props} className={cn('dig-tabs-list', className)} />; }
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof BaseTabs.Tab>) { return <BaseTabs.Tab {...props} className={cn('dig-tabs-trigger', className)} />; }
export function TabsContent({ className, ...props }: React.ComponentProps<typeof BaseTabs.Panel>) { return <BaseTabs.Panel {...props} className={cn('dig-tabs-panel', className)} />; }

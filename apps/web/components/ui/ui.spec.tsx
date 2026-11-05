// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '@/lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardTitle } from './card';
import { Checkbox } from './checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { Input } from './input';
import { Label } from './label';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './sheet';
import { Skeleton } from './skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Textarea } from './textarea';

describe('cn', () => {
  it('merges conflicting Tailwind classes and drops falsy values', () => {
    expect(cn('px-2 py-1', false && 'x', 'px-4')).toBe('py-1 px-4');
  });
});

describe('ui primitives', () => {
  it('Button fires onClick, supports variants and asChild', async () => {
    const onClick = vi.fn();
    render(<><Button onClick={onClick} variant="destructive">Delete</Button><Button asChild><a href="/x">Go</a></Button></>);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-destructive');
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/x');
  });

  it('Input and Textarea associate with a Label', () => {
    render(<><Label htmlFor="a">Name</Label><Input id="a" aria-invalid="true" /><Label htmlFor="b">Notes</Label><Textarea id="b" /></>);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });

  it('Badge, Card, Table and Skeleton render', () => {
    const { container } = render(
      <>
        <Badge variant="success">ok</Badge>
        <Card><CardTitle>Title</CardTitle></Card>
        <Table><TableHeader><TableRow><TableHead>Col</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>v</TableCell></TableRow></TableBody></Table>
        <Skeleton />
      </>,
    );
    expect(screen.getByText('ok').className).toContain('bg-success');
    expect(screen.getByRole('columnheader', { name: 'Col' })).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('Checkbox toggles via keyboard', async () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="Select" onCheckedChange={onChange} />);
    screen.getByRole('checkbox', { name: 'Select' }).focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Dialog opens, labels itself and closes with Escape', async () => {
    render(<Dialog><DialogTrigger>Open</DialogTrigger><DialogContent><DialogTitle>Sure?</DialogTitle><DialogDescription>Details</DialogDescription></DialogContent></Dialog>);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog', { name: 'Sure?' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Sheet opens from its trigger', async () => {
    render(<Sheet><SheetTrigger>Menu</SheetTrigger><SheetContent><SheetTitle>Navigation</SheetTitle><SheetDescription>Pick</SheetDescription></SheetContent></Sheet>);
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
  });

  it('DropdownMenu opens from the keyboard and runs an item', async () => {
    const onSelect = vi.fn();
    render(<DropdownMenu><DropdownMenuTrigger>Account</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={onSelect}>Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>);
    screen.getByRole('button', { name: 'Account' }).focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(onSelect).toHaveBeenCalled();
  });
});

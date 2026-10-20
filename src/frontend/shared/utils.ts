import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class composition convention, shared by the selected ReUI components. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

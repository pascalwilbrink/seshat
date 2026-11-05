'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { takeFlash } from '@/lib/flash';

/** Shows a message queued before a full navigation (for example after login) through the single root toaster. */
export function FlashToast() {
  useEffect(() => {
    const message = takeFlash();
    if (message) toast.success(message);
  }, []);
  return null;
}

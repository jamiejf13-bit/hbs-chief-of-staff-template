'use client';

import { createContext, useContext, useMemo } from 'react';

/**
 * The browser's view of lib/profile.json — branding and course codes only.
 *
 * Client components must NOT import '@/lib/profile': anything a 'use client'
 * file imports ends up in a JavaScript chunk under /_next/static, which is
 * served without the password. So the server layout picks out the harmless
 * fields and hands them down through this context, and the name and email
 * addresses never leave the server.
 */
export interface Brand {
  appName: string;
  shortName: string;
  term: string;
  section: string;
  courses: string[];
}

const BrandContext = createContext<Brand>({
  appName: 'Chief of Staff', shortName: 'CoS', term: '', section: '', courses: [],
});

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any configured course code as a word — the client twin of COURSE_RE. */
export function useCourseRe(): RegExp {
  const { courses } = useBrand();
  return useMemo(
    () => new RegExp(`\\b(${courses.map(escapeRe).join('|') || '(?!)'})\\b`, 'i'),
    [courses],
  );
}

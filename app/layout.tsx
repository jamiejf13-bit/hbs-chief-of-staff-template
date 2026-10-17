import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PROFILE } from '@/lib/profile';
import { BrandProvider } from './BrandProvider';

export const metadata: Metadata = {
  title: PROFILE.appName,
  description: 'Classwork, recruiting and calendar in one view.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192' }],
    apple: '/apple-touch-icon.png',
  },
  /**
   * Added to the home screen it opens standalone, with no address bar, and
   * keeps the dark title area rather than a white strip above the page.
   * iOS ignores the manifest for these two and wants its own meta tags.
   */
  appleWebApp: {
    capable: true,
    title: PROFILE.shortName,
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#14161a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BrandProvider
          brand={{
            appName: PROFILE.appName,
            shortName: PROFILE.shortName,
            term: PROFILE.term,
            section: PROFILE.section,
            courses: PROFILE.courses.map((c) => c.code),
          }}
        >
          {children}
        </BrandProvider>
      </body>
    </html>
  );
}

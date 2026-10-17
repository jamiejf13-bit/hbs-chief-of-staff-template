/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The worker is a separate Node process with its own tsconfig; keep it out of the web build.
  outputFileTracingExcludes: {
    '*': ['./worker/**/*'],
  },
};

export default nextConfig;

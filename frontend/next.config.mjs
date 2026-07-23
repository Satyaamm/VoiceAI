/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // antd v5 ships ESM that needs transpiling in the Next server bundle.
  transpilePackages: ['antd', '@ant-design/icons', '@ant-design/plots', 'antd-style'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3101',
  },
};

export default nextConfig;

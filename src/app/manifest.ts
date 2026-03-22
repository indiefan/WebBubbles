import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'WebBubbles',
    short_name: 'WebBubbles',
    description: 'A modern PWA client for BlueBubbles',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#007aff',
    icons: [
      {
        src: '/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}

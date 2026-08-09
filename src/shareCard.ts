import type { Session } from './statistics'

export interface ShareCardCopy {
  date: string
  distance: string
  duration: string
  calories: string
  avgSpeed: string
  heartRate?: string
  workout?: string
  badge?: string
}

export function sessionCardMetrics(session: Session) {
  return {
    distanceKm: session.distance / 1000,
    durationMin: session.duration / 60,
    kcal: Math.round(session.kcal),
    avgSpeedKmh: session.duration > 0 ? (session.distance / session.duration) * 3.6 : 0,
  }
}

export function renderSessionCard(session: Session, copy: ShareCardCopy): File {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 630
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable')

  const gradient = ctx.createLinearGradient(0, 0, 1200, 630)
  gradient.addColorStop(0, '#e8f5ff')
  gradient.addColorStop(0.55, '#d9ecff')
  gradient.addColorStop(1, '#c9e1ff')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 1200, 630)

  ctx.strokeStyle = 'rgba(10, 132, 255, 0.16)'
  ctx.lineWidth = 42
  ctx.beginPath()
  ctx.roundRect(735, 78, 350, 474, 175)
  ctx.stroke()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(10, 132, 255, 0.42)'
  ctx.stroke()

  ctx.fillStyle = '#17324d'
  ctx.font = '800 54px system-ui, sans-serif'
  ctx.fillText('Walk', 78, 94)
  const walkWidth = ctx.measureText('Walk').width
  ctx.fillStyle = '#0a84ff'
  ctx.fillText('Fit', 78 + walkWidth, 94)
  ctx.fillStyle = '#5a789a'
  ctx.font = '500 25px system-ui, sans-serif'
  ctx.fillText(copy.date, 80, 140)

  if (copy.workout) {
    ctx.fillStyle = '#0a84ff'
    ctx.font = '700 25px system-ui, sans-serif'
    ctx.fillText(copy.workout, 80, 188)
  }
  if (copy.badge) {
    ctx.fillStyle = '#fff4c7'
    ctx.beginPath()
    ctx.roundRect(80, 214, Math.min(560, ctx.measureText(copy.badge).width + 44), 52, 26)
    ctx.fill()
    ctx.fillStyle = '#8a5a00'
    ctx.font = '700 22px system-ui, sans-serif'
    ctx.fillText(`★ ${copy.badge}`, 101, 248)
  }

  const metrics = [copy.distance, copy.duration, copy.calories, copy.avgSpeed]
  if (copy.heartRate) metrics.push(copy.heartRate)
  ctx.font = '750 35px system-ui, sans-serif'
  metrics.forEach((metric, index) => {
    const col = index % 2
    const row = Math.floor(index / 2)
    const x = 80 + col * 300
    const y = 346 + row * 86
    ctx.fillStyle = '#17324d'
    ctx.fillText(metric, x, y)
  })

  ctx.fillStyle = '#5a789a'
  ctx.font = '500 20px system-ui, sans-serif'
  ctx.fillText('walkfit.app', 80, 584)

  // Keep creation synchronous: Web Share requires transient user activation, which an
  // asynchronous canvas.toBlob callback can lose before navigator.share is invoked.
  const encoded = canvas.toDataURL('image/png').split(',')[1]
  if (!encoded) throw new Error('Could not create share image')
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], `walkfit-${session.date.slice(0, 10)}.png`, { type: 'image/png' })
}

export async function shareOrDownload(file: File, title: string): Promise<'shared' | 'downloaded'> {
  const data: ShareData = { title, files: [file] }
  if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    await navigator.share(data)
    return 'shared'
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  URL.revokeObjectURL(url)
  return 'downloaded'
}

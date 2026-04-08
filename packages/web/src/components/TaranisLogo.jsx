/**
 * Taranis Capital logo component.
 *
 * Uses the actual Taranis gold chevron shield logo (PNG with transparent
 * background) with optional "Taranis Capital" wordmark.
 *
 * Props:
 *   variant: 'light' (white text for dark backgrounds) | 'dark' (green text)
 *   size: number (height in px, default 32)
 *   showText: boolean (show "Taranis Capital" text, default true)
 */
import logoSrc from '/logo.png';

export default function TaranisLogo({ variant = 'light', size = 32, showText = true }) {
  const textColour = variant === 'light' ? '#FFFFFF' : '#2C3E35';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.35 }}>
      <img
        src={logoSrc}
        alt="Taranis Capital"
        width={size}
        height={size}
        style={{ objectFit: 'contain' }}
      />
      {showText && (
        <div style={{ lineHeight: 1.1 }}>
          <div
            style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontWeight: 600,
              fontSize: size * 0.5,
              color: textColour,
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
            }}
          >
            Taranis Capital
          </div>
        </div>
      )}
    </div>
  );
}

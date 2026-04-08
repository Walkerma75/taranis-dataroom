/**
 * Ant Design 5 theme token overrides — Taranis Capital brand.
 *
 * Colours and typography per the Taranis Capital Brand Guide (April 2026).
 *   Primary Green Dark:  #2C3E35
 *   Primary Green Mid:   #3A5247
 *   Primary Gold:        #C9A84C
 *   Gold Light:          #D4B65E
 *   Charcoal (body):     #374047
 *   Off White (bg):      #F5F6F7
 *
 *   Headings: Playfair Display
 *   Body/UI:  Inter
 */

const taranisTheme = {
  token: {
    // Colour palette
    colorPrimary: '#2C3E35',
    colorLink: '#2C3E35',
    colorLinkHover: '#3A5247',
    colorSuccess: '#3A5247',
    colorWarning: '#C9A84C',
    colorInfo: '#2C3E35',
    colorTextBase: '#374047',
    colorBgBase: '#FFFFFF',
    colorBgLayout: '#F5F6F7',
    colorBorder: '#D9D9D9',
    colorBorderSecondary: '#E8E8E8',

    // Typography
    fontFamily: "'Inter', 'Calibri', 'Arial', sans-serif",
    fontFamilyCode: "'JetBrains Mono', 'Consolas', monospace",
    fontSize: 14,
    fontSizeHeading1: 32,
    fontSizeHeading2: 26,
    fontSizeHeading3: 22,
    fontSizeHeading4: 18,

    // Border radius — slightly rounded, professional
    borderRadius: 6,
    borderRadiusLG: 8,
    borderRadiusSM: 4,

    // Spacing
    padding: 16,
    paddingLG: 24,
    paddingSM: 12,

    // Shadows
    boxShadow: '0 2px 8px rgba(44, 62, 53, 0.08)',
    boxShadowSecondary: '0 4px 16px rgba(44, 62, 53, 0.12)',
  },

  components: {
    Layout: {
      headerBg: '#2C3E35',
      headerColor: '#FFFFFF',
      siderBg: '#2C3E35',
      bodyBg: '#F5F6F7',
    },
    Menu: {
      darkItemBg: '#2C3E35',
      darkItemSelectedBg: '#3A5247',
      darkItemHoverBg: '#3A5247',
      darkItemColor: 'rgba(255, 255, 255, 0.85)',
      darkItemSelectedColor: '#C9A84C',
    },
    Button: {
      primaryColor: '#FFFFFF',
      defaultBorderColor: '#2C3E35',
      defaultColor: '#2C3E35',
    },
    Typography: {
      titleMarginBottom: '0.5em',
      titleMarginTop: '0',
    },
    Table: {
      headerBg: '#F5F6F7',
      headerColor: '#2C3E35',
      rowHoverBg: 'rgba(201, 168, 76, 0.06)',
    },
  },
};

export default taranisTheme;

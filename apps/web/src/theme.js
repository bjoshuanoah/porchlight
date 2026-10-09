import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#10243A", contrastText: "#FFFFFF" },
    secondary: { main: "#D88A24", dark: "#C87918", contrastText: "#122033" },
    background: { default: "#F7F5F0", paper: "#FFFFFF" },
    text: { primary: "#122033", secondary: "#66717F" },
    divider: "#E4E0D8",
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontSize: "2rem", lineHeight: 1.25, fontWeight: 650 },
    h2: { fontSize: "1.75rem", lineHeight: 1.3, fontWeight: 650 },
    h3: { fontSize: "1.375rem", lineHeight: 1.35, fontWeight: 650 },
    body1: { fontSize: "1rem", lineHeight: 1.56 },
    body2: { fontSize: ".875rem", lineHeight: 1.45 },
  },
  shape: { borderRadius: 10 },
  breakpoints: { values: { xs: 0, sm: 480, md: 768, lg: 900, xl: 1280 } },
  components: {
    MuiCssBaseline: { styleOverrides: {
      body: { backgroundColor: "#F7F5F0" },
      "*:focus-visible": { outline: "3px solid rgba(216,138,36,.55)", outlineOffset: 2 },
      "@media (prefers-reduced-motion: reduce)": { "*, *::before, *::after": { animationDuration: "0.01ms !important", transitionDuration: "0.01ms !important" } },
    } },
    MuiButton: { styleOverrides: { root: { borderRadius: 10, minHeight: 44, textTransform: "none", fontWeight: 600 } } },
    MuiIconButton: { styleOverrides: { root: { minWidth: 44, minHeight: 44 } } },
    MuiCard: { styleOverrides: { root: { border: "1px solid #E4E0D8", borderRadius: 14, boxShadow: "0 1px 2px rgba(18,32,51,.05), 0 4px 14px rgba(18,32,51,.04)" } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 18, boxShadow: "0 20px 60px rgba(18,32,51,.18)" } } },
    MuiTextField: { defaultProps: { variant: "outlined" } },
  },
});

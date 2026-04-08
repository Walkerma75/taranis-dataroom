// vite.config.js
import { defineConfig } from "file:///tmp/taranis-web-test/node_modules/vite/dist/node/index.js";
import react from "file:///tmp/taranis-web-test/node_modules/@vitejs/plugin-react/dist/index.js";
var now = /* @__PURE__ */ new Date();
var pad = (n) => String(n).padStart(2, "0");
var buildStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;
var buildId = `DR-0.1.0-b${buildStamp}`;
var vite_config_default = defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId)
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://api:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvemVhbG91cy1jb29sLW1heHdlbGwvbW50L1RhcmFuaXMgRGF0YXJvb20vdGFyYW5pcy1kYXRhcm9vbS9wYWNrYWdlcy93ZWJcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9zZXNzaW9ucy96ZWFsb3VzLWNvb2wtbWF4d2VsbC9tbnQvVGFyYW5pcyBEYXRhcm9vbS90YXJhbmlzLWRhdGFyb29tL3BhY2thZ2VzL3dlYi92aXRlLmNvbmZpZy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vc2Vzc2lvbnMvemVhbG91cy1jb29sLW1heHdlbGwvbW50L1RhcmFuaXMlMjBEYXRhcm9vbS90YXJhbmlzLWRhdGFyb29tL3BhY2thZ2VzL3dlYi92aXRlLmNvbmZpZy5qc1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0JztcblxuLy8gQnVpbGQgaWRlbnRpZmllciBcdTIwMTQgaW5qZWN0ZWQgYXQgY29tcGlsZSB0aW1lXG5jb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuY29uc3QgcGFkID0gKG4pID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCAnMCcpO1xuY29uc3QgYnVpbGRTdGFtcCA9IGAke25vdy5nZXRGdWxsWWVhcigpfSR7cGFkKG5vdy5nZXRNb250aCgpICsgMSl9JHtwYWQobm93LmdldERhdGUoKSl9LiR7cGFkKG5vdy5nZXRIb3VycygpKX0ke3BhZChub3cuZ2V0TWludXRlcygpKX1gO1xuY29uc3QgYnVpbGRJZCA9IGBEUi0wLjEuMC1iJHtidWlsZFN0YW1wfWA7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtyZWFjdCgpXSxcbiAgZGVmaW5lOiB7XG4gICAgX19CVUlMRF9JRF9fOiBKU09OLnN0cmluZ2lmeShidWlsZElkKSxcbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgcG9ydDogNTE3MyxcbiAgICBob3N0OiAnMC4wLjAuMCcsXG4gICAgcHJveHk6IHtcbiAgICAgICcvYXBpJzoge1xuICAgICAgICB0YXJnZXQ6ICdodHRwOi8vYXBpOjQwMDAnLFxuICAgICAgICBjaGFuZ2VPcmlnaW46IHRydWUsXG4gICAgICAgIHJld3JpdGU6IChwYXRoKSA9PiBwYXRoLnJlcGxhY2UoL15cXC9hcGkvLCAnJyksXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBdWEsU0FBUyxvQkFBb0I7QUFDcGMsT0FBTyxXQUFXO0FBR2xCLElBQU0sTUFBTSxvQkFBSSxLQUFLO0FBQ3JCLElBQU0sTUFBTSxDQUFDLE1BQU0sT0FBTyxDQUFDLEVBQUUsU0FBUyxHQUFHLEdBQUc7QUFDNUMsSUFBTSxhQUFhLEdBQUcsSUFBSSxZQUFZLENBQUMsR0FBRyxJQUFJLElBQUksU0FBUyxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxRQUFRLENBQUMsQ0FBQyxJQUFJLElBQUksSUFBSSxTQUFTLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxXQUFXLENBQUMsQ0FBQztBQUNySSxJQUFNLFVBQVUsYUFBYSxVQUFVO0FBRXZDLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixRQUFRO0FBQUEsSUFDTixjQUFjLEtBQUssVUFBVSxPQUFPO0FBQUEsRUFDdEM7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxRQUNkLFNBQVMsQ0FBQyxTQUFTLEtBQUssUUFBUSxVQUFVLEVBQUU7QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K

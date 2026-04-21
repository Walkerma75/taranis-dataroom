import { useEffect, useRef } from 'react';
import { Viewer, Worker, SpecialZoomLevel } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';

import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';

/**
 * Custom PDF viewer using react-pdf-viewer.
 * Shows outline/bookmarks sidebar, zoom, page navigation.
 * Hides download, print, and open-file toolbar buttons.
 */
export default function PdfViewer({ fileUrl, height = 600 }) {
  const defaultLayoutPluginInstance = defaultLayoutPlugin({
    // Open the bookmarks/outline tab by default (tab index 2)
    sidebarTabs: (defaultTabs) => {
      // defaultTabs: [0] = Thumbnails, [1] = Bookmarks, [2] = Attachments
      // Return only thumbnails and bookmarks, with bookmarks selected by default
      return [
        defaultTabs[0], // Thumbnails
        defaultTabs[1], // Bookmarks
      ];
    },
    toolbarPlugin: {
      fullScreenPlugin: {
        // Keep full screen available
      },
      // Remove download and print buttons via renderToolbar
      getFilePlugin: {
        // Disable the download button
        fileNameGenerator: () => '',
      },
      printPlugin: {
        // We'll hide the button via renderToolbar
      },
    },
    renderToolbar: (Toolbar) => (
      <Toolbar>
        {(slots) => {
          const {
            CurrentPageInput,
            GoToNextPage,
            GoToPreviousPage,
            NumberOfPages,
            ShowSearchPopover,
            Zoom,
            ZoomIn,
            ZoomOut,
            EnterFullScreen,
          } = slots;
          return (
            <div
              style={{
                alignItems: 'center',
                display: 'flex',
                width: '100%',
                justifyContent: 'center',
              }}
            >
              <div style={{ padding: '0 4px' }}>
                <ShowSearchPopover />
              </div>
              <div style={{ padding: '0 4px' }}>
                <GoToPreviousPage />
              </div>
              <div style={{ padding: '0 4px', display: 'flex', alignItems: 'center' }}>
                <CurrentPageInput /> <span style={{ padding: '0 4px' }}>/</span> <NumberOfPages />
              </div>
              <div style={{ padding: '0 4px' }}>
                <GoToNextPage />
              </div>
              <div style={{ padding: '0 4px', marginLeft: 'auto' }}>
                <ZoomOut />
              </div>
              <div style={{ padding: '0 4px' }}>
                <Zoom />
              </div>
              <div style={{ padding: '0 4px' }}>
                <ZoomIn />
              </div>
              <div style={{ padding: '0 4px', marginLeft: 'auto' }}>
                <EnterFullScreen />
              </div>
            </div>
          );
        }}
      </Toolbar>
    ),
  });

  // Open the bookmarks tab automatically after render
  const { activateTab } = defaultLayoutPluginInstance;
  useEffect(() => {
    // Activate bookmarks tab (index 1)
    activateTab(1);
  }, []);

  return (
    <Worker workerUrl="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js">
      <div style={{ height, width: '100%' }}>
        <Viewer
          fileUrl={fileUrl}
          plugins={[defaultLayoutPluginInstance]}
          defaultScale={SpecialZoomLevel.PageWidth}
        />
      </div>
    </Worker>
  );
}

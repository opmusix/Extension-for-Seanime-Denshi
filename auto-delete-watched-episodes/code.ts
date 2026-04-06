/// <reference path="core.d.ts" />
/// <reference path="app.d.ts" />
/// <reference path="plugin.d.ts" />
/// <reference path="system.d.ts" />

/**
 * Auto Delete Watched Episodes Plugin for Seanime
 *
 * This plugin automatically deletes local episode files when you finish watching them.
 * Unlike the manual "Delete Watched Episodes" plugin, this works automatically in the background.
 * 
 * Features:
 * - Shows a 10-second countdown notification before deletion
 * - Cancel button to prevent deletion
 * - Configurable via tray settings
 */

interface DeletedEpisode {
  path: string;
  episode: number;
  animeTitle: string;
  deletedAt: string;
}

interface PendingDeletion {
  path: string;
  episode: number;
  animeTitle: string;
  countdown: number;
  timerId: (() => void) | null;
}

// @ts-ignore
function init() {
  console.log('[Auto Delete Watched Episodes] Plugin loaded');
}

$ui.register(function (ctx) {
  console.log('[Auto Delete Watched Episodes] UI context registered');

  // State
  const isEnabled = ctx.state<boolean>(true);
  const ignoreLocked = ctx.state<boolean>(true);
  const excludeList = ctx.state<string[]>([]);
  const deletedHistory = ctx.state<DeletedEpisode[]>([]);
  const lastDeleted = ctx.state<DeletedEpisode | null>(null);
  const pendingDeletion = ctx.state<PendingDeletion | null>(null);
  const countdownValue = ctx.state<number>(10);

  // Load settings from storage
  const savedEnabled = $storage.get<boolean>('autoDeleteEnabled');
  if (savedEnabled !== undefined) isEnabled.set(savedEnabled);

  const savedIgnoreLocked = $storage.get<boolean>('autoDeleteIgnoreLocked');
  if (savedIgnoreLocked !== undefined) ignoreLocked.set(savedIgnoreLocked);

  const savedExcludeList = $storage.get<string[]>('autoDeleteExcludeList');
  if (savedExcludeList) excludeList.set(savedExcludeList);

  const savedHistory = $storage.get<DeletedEpisode[]>('autoDeleteHistory');
  if (savedHistory) deletedHistory.set(savedHistory.slice(0, 50)); // Keep last 50

  // Field refs for settings
  const enabledRef = ctx.fieldRef<boolean>(isEnabled.get());
  const ignoreLockedRef = ctx.fieldRef<boolean>(ignoreLocked.get());
  const newExcludeRef = ctx.fieldRef<string>('');

  // Tray for showing status and settings
  const tray = ctx.newTray({
    iconUrl:
      'https://raw.githubusercontent.com/dadangdut33/seanime-extensions/refs/heads/master/plugins/auto-delete-watched-episodes/icon.png',
    withContent: true,
    width: '400px',
    minHeight: '200px',
  });

  // Helper to save settings
  function saveSettings() {
    $storage.set('autoDeleteEnabled', enabledRef.current);
    $storage.set('autoDeleteIgnoreLocked', ignoreLockedRef.current);
    $storage.set('autoDeleteExcludeList', excludeList.get());

    isEnabled.set(enabledRef.current);
    ignoreLocked.set(ignoreLockedRef.current);

    ctx.toast.success('Settings saved');
    tray.update();
  }

  // Helper to add to history
  function addToHistory(episode: DeletedEpisode) {
    const newHistory = [episode, ...deletedHistory.get()].slice(0, 50);
    deletedHistory.set(newHistory);
    lastDeleted.set(episode);
    $storage.set('autoDeleteHistory', newHistory);
    tray.update();
  }

  // Helper to check if anime is excluded
  function isExcluded(animeTitle: string, filePath: string): boolean {
    const lowerTitle = animeTitle.toLowerCase();
    const lowerPath = filePath.toLowerCase();

    return excludeList.get().some(function(filter: string) {
      const cleanFilter = filter.toLowerCase().trim();
      return lowerTitle.includes(cleanFilter) || lowerPath.includes(cleanFilter);
    });
  }

  // Helper to cancel pending deletion
  function cancelPendingDeletion() {
    const pending = pendingDeletion.get();
    if (pending && pending.timerId) {
      pending.timerId(); // Call the cancel function
    }
    pendingDeletion.set(null);
    countdownValue.set(10);
    ctx.toast.info('Deletion cancelled');
    tray.updateBadge({ number: 0 });
    tray.update();
  }

  // Helper to execute file deletion
  function executeDeletion(path: string, animeTitle: string, episodeNumber: number | undefined) {
    try {
      $os.remove(path);
      console.log(`[Auto Delete] Successfully deleted: ${path}`);

      const deletedEpisode: DeletedEpisode = {
        path: path,
        episode: episodeNumber || 0,
        animeTitle: animeTitle,
        deletedAt: new Date().toISOString(),
      };

      addToHistory(deletedEpisode);
      ctx.toast.success(`Deleted: ${animeTitle} Ep ${episodeNumber || '?'}`);

      // Notify auto scanner to refresh
      ctx.autoScanner.notify();
    } catch (e) {
      console.error('[Auto Delete] Failed to delete file:', e);
      ctx.toast.error(`Failed to delete episode: ${animeTitle} Ep ${episodeNumber || '?'}`);
    }
  }

  // Main function: Handle video completed event
  function handleVideoCompleted(event: $app.VideoCompletedEvent) {
    if (!isEnabled.get()) {
      console.log('[Auto Delete] Plugin disabled, skipping');
      return;
    }

    // Cancel any existing pending deletion
    if (pendingDeletion.get()) {
      cancelPendingDeletion();
    }

    try {
      // Get current playback info
      const playbackInfo = ctx.playback.getCurrentPlaybackInfo();
      if (!playbackInfo) {
        console.log('[Auto Delete] No playback info available');
        return;
      }

      // Only process local files (not streams)
      if (playbackInfo.playbackType !== 'localfile' || !playbackInfo.localFile) {
        console.log('[Auto Delete] Not a local file, skipping');
        return;
      }

      const localFile = playbackInfo.localFile;
      const filePath = localFile.path;
      const episodeNumber = localFile.metadata?.episode;
      const media = playbackInfo.media;
      const animeTitle = media?.title?.userPreferred || 'Unknown Anime';

      console.log(`[Auto Delete] Video completed: ${animeTitle} Ep ${episodeNumber}`);
      console.log(`[Auto Delete] File path: ${filePath}`);

      // Check if file is locked
      if (ignoreLocked.get() && localFile.locked) {
        console.log('[Auto Delete] File is locked, skipping');
        ctx.toast.info(`Skipped locked episode: ${animeTitle} Ep ${episodeNumber}`);
        return;
      }

      // Check if anime is in exclude list
      if (isExcluded(animeTitle, filePath)) {
        console.log('[Auto Delete] Anime is in exclude list, skipping');
        ctx.toast.info(`Skipped excluded anime: ${animeTitle}`);
        return;
      }

      // Check if file exists
      try {
        $os.stat(filePath);
      } catch (e) {
        console.log('[Auto Delete] File does not exist, skipping');
        return;
      }

      // Set up pending deletion with countdown
      countdownValue.set(10);
      
      const timerId = ctx.setInterval(function() {
        const current = countdownValue.get();
        if (current > 1) {
          countdownValue.set(current - 1);
          tray.update();
        } else {
          // Time's up - execute deletion
          const pending = pendingDeletion.get();
          if (pending && pending.timerId) {
            pending.timerId(); // Call the cancel function
          }
          pendingDeletion.set(null);
          countdownValue.set(10);
          tray.updateBadge({ number: 0 });
          tray.update();
          
          // Delete the file
          executeDeletion(filePath, animeTitle, episodeNumber);
        }
      }, 1000);

      const newPending: PendingDeletion = {
        path: filePath,
        episode: episodeNumber || 0,
        animeTitle: animeTitle,
        countdown: 10,
        timerId: timerId,
      };

      pendingDeletion.set(newPending);
      tray.updateBadge({ number: 10, intent: 'warning' });
      tray.update();

      // Show initial notification
      ctx.notification.send(`Deleting ${animeTitle} Ep ${episodeNumber || '?'} in 10s... Click tray icon to cancel`);
      ctx.toast.warning(`Deleting in 10s: ${animeTitle} Ep ${episodeNumber || '?'}`);

    } catch (error) {
      console.error('[Auto Delete] Error handling video completed:', error);
    }
  }

  // Register the video-completed event listener
  ctx.playback.addEventListener('video-completed', handleVideoCompleted);
  console.log('[Auto Delete] Registered video-completed listener');

  // Event handlers
  const saveSettingsHandler = ctx.eventHandler('save-settings', saveSettings);
  const cancelDeletionHandler = ctx.eventHandler('cancel-deletion', cancelPendingDeletion);

  const addExcludeHandler = ctx.eventHandler('add-exclude', function () {
    const path = newExcludeRef.current.trim();
    if (!path) return;

    if (!excludeList.get().includes(path)) {
      excludeList.set([...excludeList.get(), path]);
      newExcludeRef.setValue('');
      $storage.set('autoDeleteExcludeList', excludeList.get());
      tray.update();
    }
  });

  // Render tray content
  tray.render(function () {
    const style = tray.css(`
      .adwe-content {
        max-height: 350px;
        overflow: auto;
      }
      .adwe-text-muted {
        color: #6b7280;
      }
      .adwe-text-green {
        color: #22c55e;
      }
      .adwe-text-warning {
        color: #f59e0b;
      }
      .adwe-text-red {
        color: #ef4444;
      }
      .adwe-history-item {
        border-bottom: 1px solid #3b3b3b;
        padding: 8px 0;
      }
      .adwe-history-item:last-child {
        border-bottom: none;
      }
      .adwe-countdown-box {
        background: linear-gradient(135deg, #451a03 0%, #78350f 100%);
        border: 2px solid #f59e0b;
        border-radius: 12px;
        padding: 16px;
        text-align: center;
        animation: pulse 1s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { border-color: #f59e0b; }
        50% { border-color: #fbbf24; }
      }
      .adwe-countdown-number {
        font-size: 32px;
        font-weight: bold;
        color: #fbbf24;
      }
    `);

    // Header
    const header = tray.div([
      tray.div([
        tray.text('Auto Delete Watched Episodes', { className: 'text-lg font-bold' }),
        tray.text('Shows countdown before deleting watched episodes.', {
          className: 'text-xs adwe-text-muted',
        }),
      ], { className: 'flex flex-col gap-1 mb-4' }),
    ]);

    // Countdown / Pending Deletion Section
    let pendingSection: any = tray.div([]);
    const pending = pendingDeletion.get();
    
    if (pending) {
      const countdown = countdownValue.get();
      pendingSection = tray.div([
        tray.text('Deletion Pending!', { className: 'text-sm font-semibold mb-2 adwe-text-warning' }),
        tray.div([
          tray.text(String(countdown), { className: 'adwe-countdown-number' }),
          tray.text('seconds until deletion', { className: 'text-xs adwe-text-muted' }),
        ], { className: 'adwe-countdown-box mb-3' }),
        tray.div([
          tray.text(`${pending.animeTitle}`, { className: 'text-sm font-medium' }),
          tray.text(`Episode ${pending.episode}`, { className: 'text-xs adwe-text-muted' }),
        ], { className: 'mb-3' }),
        tray.button({
          label: 'CANCEL DELETION',
          intent: 'alert',
          onClick: cancelDeletionHandler,
          className: 'w-full',
        }),
      ], { className: 'mb-4' });
    }

    // Settings section
    const settingsSection = tray.div([
      tray.div([
        tray.checkbox('Enable Auto Delete', { fieldRef: enabledRef }),
        tray.text('Show countdown and delete files after episodes finish', {
          className: 'text-xs adwe-text-muted',
        }),
      ], { className: 'flex flex-col gap-0 mb-3' }),

      tray.div([
        tray.checkbox('Ignore Locked Files', { fieldRef: ignoreLockedRef }),
        tray.text('Skip files marked as locked in Seanime', {
          className: 'text-xs adwe-text-muted',
        }),
      ], { className: 'flex flex-col gap-0 mb-3' }),

      // Exclude list
      tray.div([
        tray.text('Exclude List', { className: 'text-sm font-semibold mb-1' }),
        tray.text('Anime titles to exclude from auto-deletion', {
          className: 'text-xs adwe-text-muted mb-2',
        }),

        tray.div([
          tray.input({
            placeholder: 'Enter anime title to exclude',
            fieldRef: newExcludeRef,
          }),
          tray.button({
            label: 'Add',
            intent: 'primary-subtle',
            onClick: addExcludeHandler,
          }),
        ], { className: 'flex gap-2 mb-2' }),

        excludeList.get().length > 0
          ? tray.div(
              excludeList.get().map(function (item: string, index: number) {
                return tray.div([
                  tray.text(item, { className: 'text-xs flex-1 truncate' }),
                  tray.button({
                    label: 'Remove',
                    intent: 'alert-subtle',
                    size: 'xs',
                    onClick: ctx.eventHandler(`remove-exclude-${index}`, function () {
                      excludeList.set(excludeList.get().filter(function(_: string, i: number) { return i !== index; }));
                      $storage.set('autoDeleteExcludeList', excludeList.get());
                      tray.update();
                    }),
                  }),
                ], { className: 'flex items-center gap-2 p-2' });
              }),
              { className: 'bg-[#121212] border border-[#3b3b3b] rounded-lg max-h-[100px] overflow-auto' }
            )
          : tray.text('No exclusions', { className: 'text-xs adwe-text-muted italic' }),
      ], { className: 'flex flex-col mb-3' }),

      // Save button
      tray.button({
        label: 'Save Settings',
        intent: 'primary',
        onClick: saveSettingsHandler,
        className: 'w-full',
      }),
    ], { className: 'mb-4' });

    // Status section
    let statusText: string;
    let statusColor: string;
    
    if (pending) {
      statusText = `Deleting ${pending.animeTitle} Ep ${pending.episode} in ${countdownValue.get()}s...`;
      statusColor = 'adwe-text-warning';
    } else if (isEnabled.get()) {
      statusText = 'Active - 10s countdown before deletion';
      statusColor = 'adwe-text-green';
    } else {
      statusText = 'Disabled - No files will be deleted';
      statusColor = 'adwe-text-muted';
    }

    const statusSection = tray.div([
      tray.text('Status', { className: 'text-sm font-semibold mb-2' }),
      tray.text(statusText, { className: `text-sm ${statusColor}` }),
    ], { className: 'mb-4' });

    // Last deleted section
    let lastDeletedSection: any = tray.div([]);
    if (lastDeleted.get() && !pending) {
      const last = lastDeleted.get()!;
      const date = new Date(last.deletedAt).toLocaleString();
      lastDeletedSection = tray.div([
        tray.text('Last Deleted', { className: 'text-sm font-semibold mb-2' }),
        tray.div([
          tray.text(`${last.animeTitle} - Ep ${last.episode}`, { className: 'text-sm' }),
          tray.text(date, { className: 'text-xs adwe-text-muted' }),
        ], { className: 'adwe-history-item' }),
      ], { className: 'mb-4' });
    }

    // History section (collapsed)
    const historySection = deletedHistory.get().length > 0 && !pending
      ? tray.div([
          tray.text(`History (${deletedHistory.get().length} episodes)`, { className: 'text-sm font-semibold mb-2' }),
          tray.div(
            deletedHistory.get().slice(0, 5).map(function (item: DeletedEpisode) {
              const date = new Date(item.deletedAt).toLocaleDateString();
              return tray.div([
                tray.text(`${item.animeTitle} - Ep ${item.episode}`, { className: 'text-xs' }),
                tray.text(date, { className: 'text-xs adwe-text-muted' }),
              ], { className: 'adwe-history-item' });
            }),
            { className: 'max-h-[150px] overflow-auto' }
          ),
        ], { className: 'mb-4' })
      : tray.div([]);

    return tray.div([
      style,
      header,
      pendingSection,
      statusSection,
      settingsSection,
      lastDeletedSection,
      historySection,
    ], { className: 'adwe-content' });
  });
});

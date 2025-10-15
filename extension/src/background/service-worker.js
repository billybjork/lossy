// Service Worker for Voice Video Companion
// Phase 0: Basic setup

chrome.runtime.onInstalled.addListener(() => {
  console.log('Voice Video Companion installed');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('Message received:', msg);
  sendResponse({status: 'ok'});
  return true;
});

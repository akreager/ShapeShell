// The isolated world shares the DOM but not JS globals with the page.
document.documentElement.dataset.extSurveyIsolated = typeof window.__extSurveyMainGlobal === 'undefined' ? 'separate' : 'shared';

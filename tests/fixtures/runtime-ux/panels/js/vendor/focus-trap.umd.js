// Stand-in for the focus-trap UMD bundle.
window.focusTrap = {
  createFocusTrap: function () {
    return { activate: function () {}, deactivate: function () {} };
  },
};

"""Shared GeoSuite toolbar.

Aggregates the toolbar items of the managed plugins into a single
QToolBar(objectName="GeoSuite"). Each plugin shares it find-or-create, so
whichever plugin is enabled first ends up on the same toolbar.

Other plugins must work without depending on the driver, so this find-or-create
logic is duplicated in each plugin as a small, identical helper (same policy as
the duplication in i18n_json.py). The driver itself uses this module and puts
the mode badge (permanently showing development mode / user mode) at the front.
"""

TOOLBAR_NAME = "GeoSuite"


def geo_suite_toolbar(iface, ensure_visible=True):
    """Return the GeoSuite toolbar, creating it when absent.

    With ensure_visible=True (the default) the visible state is guaranteed.
    Always keep it True on the item-adding path so that the toolbar is shown
    even when a plugin is used individually without the driver running.
    Pass False when the display must not change, as on the removeAction
    path during unload.
    """
    from qgis.PyQt.QtWidgets import QToolBar
    tb = iface.mainWindow().findChild(QToolBar, TOOLBAR_NAME)
    if tb is None:
        tb = iface.addToolBar(TOOLBAR_NAME)
        tb.setObjectName(TOOLBAR_NAME)
    if ensure_visible:
        tb.setVisible(True)
    return tb

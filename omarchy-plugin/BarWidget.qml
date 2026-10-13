import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// A launcher for the Stickit app. Stickit keeps running in the tray; this button talks to it by
// launching the same binary, which Stickit's single-instance handling forwards to the running copy
// (or starts it if it isn't running yet).
//   left click   show / hide the notes list
//   middle click new note
BarWidget {
    id: root
    moduleName: "io.github.menobass.stickit"

    implicitWidth: button.implicitWidth
    width: implicitWidth
    implicitHeight: button.implicitHeight

    // Set "command" on this widget's entry in shell.json if `stickit` isn't on the shell's PATH,
    // e.g. "/home/you/.local/bin/stickit".
    readonly property string command: setting("command", "stickit")

    function run(flag) {
        Quickshell.execDetached({ command: [root.command, flag] })
    }

    WidgetButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        text: "Stickit"          // non-empty keeps the button visible; the icon is drawn below
        labelVisible: false
        tooltipText: "Stickit\nClick: show / hide notes\nMiddle-click: new note"
        fixedWidth: Math.ceil(Style.space(16) + Style.spaceReal(horizontalMargin) * 2)
        onPressed: function(b) {
            root.run(b === Qt.MiddleButton ? "--new" : "--toggle")
        }

        Image {
            anchors.centerIn: parent
            width: Style.space(16)
            height: width
            source: Qt.resolvedUrl("assets/stickit-128.png")
            sourceSize.width: 64
            sourceSize.height: 64
            smooth: true
            mipmap: true
        }
    }
}

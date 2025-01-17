import QtQuick 2.0
import QtQuick.Layouts 1.12
import UIBase 1.0
import Printer 1.0
import "qrc:/uibase/qml/widgets"
import "../dialog"

Item {
    property alias name: textConfirm.objectName
    property var modelData: ({}) /* friendly, bambu, cfw, icon */
    property var cfwVersion: ({}) /* from cfwversions.json: version, ... */
    property var mappedData: ({}) /* hw_ver, sn, sw_ver */
    property var isHw: (mappedData.sn && mappedData.sn != "" && mappedData.hw_ver && mappedData.hw_ver != "")
    property var needsUpdate: (!cfwVersion.invalid && mappedData.sw_ver.split("/")[0] != cfwVersion.version)

    property var buttons: SimpleItemModel {
        DialogButtonItem {
            name: "do_install"; title: ("Install " + cfwVersion.version)
            isDefault: defaultButton == 0
            keepDialog: true
            onClicked: {
                dialogStack.pop();
                dialogStack.popupDialog('../settings/UpgradeDialog', {
                    module: mappedData.name,
                    friendly: modelData.friendly,
                    version: cfwVersion.version,
                    url: cfwVersion.paths[mappedData.hw_ver.toLowerCase()]['url'],
                    md5: cfwVersion.paths[mappedData.hw_ver.toLowerCase()]['md5'],
                })
            }
            visible: needsUpdate && !cfwVersion.noUpgrade
        }
        DialogButtonItem {
            name: "no"; title: "Return"
            isDefault: defaultButton == 1
            onClicked: { ; }
        }
    }
    property bool finished: false

    id: textConfirm
    width: 960
    height: layout.height
    
    RowLayout {
        id: layout
        width: 960
        spacing: 0
        
        Image {
            id: moduleIcon
            Layout.preferredWidth: 128
            Layout.preferredHeight: 128
            Layout.rightMargin: 24
            Layout.alignment: Qt.AlignTop | Qt.AlignLeft
            fillMode: Image.PreserveAspectFit
            source: modelData.icon
        }
        
        GridLayout {
            rowSpacing: 6
            columnSpacing: 12
            columns: 2
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignLeft | Qt.AlignTop
            Layout.maximumWidth: 1000
            
            Text {
                Layout.columnSpan: 2
                Layout.fillWidth: true
                Layout.bottomMargin: 18
                font: Fonts.body_36
                color: Colors.gray_100
                wrapMode: Text.Wrap
                text: cfwVersion.dialogName ? cfwVersion.dialogName : modelData.friendly
            }

            Text {
                Layout.fillWidth: true
                font: Fonts.body_26
                color: Colors.gray_200
                wrapMode: Text.Wrap
                visible: isHw
                text: `<b>Serial number</b>: ${mappedData.sn}`
            }

            Text {
                Layout.fillWidth: true
                font: Fonts.body_26
                color: Colors.gray_200
                wrapMode: Text.Wrap
                visible: isHw
                text: `<b>Hardware revision</b>: ${mappedData.hw_ver}`
            }
            
            
            Text {
                Layout.fillWidth: true
                font: Fonts.body_26
                color: Colors.gray_200
                wrapMode: Text.Wrap
                Layout.columnSpan: 2
                text: `<b>Firmware version</b>: ${mappedData.sw_ver.split("/")[0]}` + (needsUpdate ? ` (<font color='#ff6f00'><i>recommended: ${cfwVersion.version.split("/")[0]}</i></font>)` : "")
            }
            
            Text {
                Layout.fillWidth: true
                Layout.topMargin: 18
                font: Fonts.body_26
                color: Colors.gray_200
                wrapMode: Text.Wrap
                Layout.columnSpan: 2
                text: !needsUpdate && !cfwVersion.alwaysNoUpgrade ? "This component has the recommended firmware version installed." :
                      cfwVersion.noUpgrade ? cfwVersion.noUpgrade :
                      "This component's firmware version does not match the running system firmware version.  Printing may not be reliable.  Install new firmware now?"
            }
        }
    }
}

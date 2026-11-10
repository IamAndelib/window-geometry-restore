// A test window for the KWin sandbox (tests/kwin/sandbox.py builds it).
//
//   testwindow APP_ID TITLE [WIDTHxHEIGHT] [fixed] [maximized] [retitle=NEW]
//
// The app id becomes the window's resourceClass in KWin, so scenarios can run
// several apps side by side. "fixed" makes the window non-resizable; "maximized"
// opens it maximized, as apps that remember being maximized do. "retitle=NEW"
// changes the title to NEW shortly after the window is shown, as browsers do.
#include <QColor>
#include <QGuiApplication>
#include <QPainter>
#include <QRasterWindow>
#include <QTimer>

class Window : public QRasterWindow
{
protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter(this).fillRect(QRect(QPoint(), size()), QColor(0x3b, 0x6e, 0xa5));
    }
};

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    const QStringList args = app.arguments();
    if (args.size() < 3) {
        return 2;
    }
    QGuiApplication::setDesktopFileName(args[1]);
    Window window;
    window.setTitle(args[2]);
    QSize size(800, 500);
    if (args.size() > 3 && args[3].contains(QLatin1Char('x'))) {
        const QStringList parts = args[3].split(QLatin1Char('x'));
        size = QSize(parts[0].toInt(), parts[1].toInt());
    }
    window.resize(size);
    if (args.contains(QStringLiteral("fixed"))) {
        window.setMinimumSize(size);
        window.setMaximumSize(size);
    }
    if (args.contains(QStringLiteral("maximized"))) {
        window.showMaximized();
    } else {
        window.show();
    }
    for (const QString &arg : args) {
        if (arg.startsWith(QStringLiteral("retitle="))) {
            const QString title = arg.mid(8);
            QTimer::singleShot(300, &window, [&window, title]() { window.setTitle(title); });
        }
    }
    return app.exec();
}

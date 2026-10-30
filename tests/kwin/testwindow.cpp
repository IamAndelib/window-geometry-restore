// A test window for the KWin sandbox (tests/kwin/sandbox.py builds it).
//
//   testwindow APP_ID TITLE [WIDTHxHEIGHT] [fixed]
//
// The app id becomes the window's resourceClass in KWin, so scenarios can run
// several apps side by side. "fixed" makes the window non-resizable.
#include <QColor>
#include <QGuiApplication>
#include <QPainter>
#include <QRasterWindow>

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
    window.show();
    return app.exec();
}

// vim:fdm=syntax
// by tuberry
/* exported Paper */
'use strict';

const Cairo = imports.cairo;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const { Gio, Clutter, Meta, PangoCairo, Pango, St, GObject } = imports.gi;
const Fields = imports.misc.extensionUtils.getCurrentExtension().imports.fields.Fields;

const splitAt = i => x => [x.slice(0, i), x.slice(i)];
const toMS = x => x.split(':').reverse().reduce((a, v, i) => a + parseFloat(v) * 60 ** i, 0) * 1000; // 1:1 => 61000 ms
const genParam = (type, name, ...dflt) => GObject.ParamSpec[type](name, name, name, GObject.ParamFlags.READWRITE, ...dflt);

class DragMove extends DND._Draggable {
    _dragActorDropped(event) {
        // override this for moving only and do nothing more
        this._dragCancellable = false;
        this._dragState = DND.DragState.INIT;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this.emit('drag-end', event.get_time(), true);
        this._dragComplete();

        return true;
    }
}

var Paper = class extends GObject.Object {
    static {
        GObject.registerClass({
            Properties: {
                drag:     genParam('boolean', 'drag', false),
                hide:     genParam('boolean', 'hide', false),
                orient:   genParam('uint', 'orient', 0, 1, 0),
                font:     genParam('string',  'font', 'Sans 40'),
                xpos:     genParam('int', 'xpos', -100, 65535, 10),
                ypos:     genParam('int', 'ypos', -100, 65535, 10),
                offset:   genParam('int', 'offset', -100000, 100000, 0),
                outline:  genParam('string', 'outline', 'rgba(0, 0, 0, 0.2)'),
                active:   genParam('string', 'active', 'rgba(100, 50, 150, 0.5)'),
                inactive: genParam('string', 'inactive', 'rgba(230, 230, 230, 0.5)'),
                position: genParam('int64', 'position', 0, Number.MAX_SAFE_INTEGER, 0),
            },
        }, this);
    }

    constructor(gsettings) {
        super();
        this.length = 0;
        this.text = '';
        this._gsettings = gsettings;
        this._area = new St.DrawingArea({ reactive: false });
        this.bind_property('hide', this._area, 'visible', GObject.BindingFlags.INVERT_BOOLEAN);
        Main.uiGroup.add_actor(this._area);
        this._bindSettings();
        this._area.set_position(this.xpos, this.ypos);
        this._area.connect('repaint', this._repaint.bind(this));
    }

    _bindSettings() {
        [
            [Fields.FONT,     'font'],
            [Fields.DRAG,     'drag'],
            [Fields.ACTIVE,   'active'],
            [Fields.OUTLINE,  'outline'],
            [Fields.INACTIVE, 'inactive'],
            [Fields.XPOS,     'xpos', Gio.SettingsBindFlags.DEFAULT],
            [Fields.YPOS,     'ypos', Gio.SettingsBindFlags.DEFAULT],
            [Fields.ORIENT,   'orient'],
        ].forEach(([x, y, z]) => this._gsettings.bind(x, this, y, z ?? Gio.SettingsBindFlags.GET));
    }

    getColor(color, fallbk) {
        let [ok, cl] = Clutter.Color.from_string(color);
        return ok ? [cl.red / 255, cl.green / 255, cl.blue / 255, cl.alpha / 255] : fallbk;
    }

    set active(active) {
        this._active = this.getColor(active, [0.4, 0.2, 0.6, 0.5]);
    }

    set outline(outline) {
        this._outline = this.getColor(outline, [0, 0, 0, 0.2]);
    }

    set inactive(inactive) {
        this._inactive = this.getColor(inactive, [0.9, 0.9, 0.9, 0.5]);
    }

    set font(font) {
        this._font = Pango.FontDescription.from_string(font);
    }

    set drag(drag) {
        if(drag) {
            if(this._drag) return;
            Main.layoutManager.trackChrome(this._area);
            this._area.reactive = true;
            this._drag = new DragMove(this._area, { dragActorOpacity: 200 });
            this._drag.connect('drag-end', () => {
                Main.layoutManager.untrackChrome(this._area);
                this._gsettings.set_boolean(Fields.DRAG, false);
                [this.xpos, this.ypos] = this._area.get_position();
            });
        } else {
            if(!this._drag) return;
            this._drag = null;
            this._area.reactive = false;
        }
    }

    set position(position) {
        this._position = position;
        if(this._area.visible) this._area.queue_repaint();
    }

    set orient(orient) {
        this._orient = orient;
        let [w, h] = global.display.get_size();
        orient ? this._area.set_size(0.18 * w, h) : this._area.set_size(w, 0.3 * h);
    }

    _repaint(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        this.draw(cr, w, h);

        cr.$dispose();
    }

    set text(text) {
        this._text = text.split(/\n/)
            .flatMap(x => (i => i > 0 ? [splitAt(i + 1)(x)] : [])(x.lastIndexOf(']')))
            .flatMap(x => x[0].match(/(?<=\[)[^\][]+(?=])/g).map(y => [Math.round(toMS(y)), x[1]]))
            .sort((u, v) => u[0] > v[0])
            .reduce((a, v, i, arr) => a.set([v[0]], [v[0], arr[i + 1] ? arr[i + 1][0] : Math.max(this.length, v[0]), v[1]]), new Map());
        this._tags = Array.from(this._text.keys()).reverse();
        this.offset = 0;
    }

    get text() {
        let now = this._position + this.offset;
        let key = this._tags.find(k => parseFloat(k) <= now);
        if(key === undefined) return [0, ''];
        let [s, e, t] = this._text.get(key);
        return [now >= e || s === e ? 1 : (now - s) / (e - s), t];
    }

    draw(cr, w, _h) {
        let [position, txt] = this.text;
        if(!txt) return;
        cr.save();
        let ly = PangoCairo.create_layout(cr);
        ly.set_font_description(this._font);
        ly.set_text(txt, -1);
        let [fw, fh] = ly.get_pixel_size();
        let gd = this._orient ? new Cairo.LinearGradient(0, 0, 0, fw) : new Cairo.LinearGradient(0, 0, fw, 0);
        [[0, this._active], [position, this._active], [position, this._inactive],
            [1, this._inactive]].forEach(([x, y]) => gd.addColorStopRGBA(x, ...y));
        cr.moveTo((a => a > 0 ? 0 : a)(w - position * fw), 0);
        cr.setSource(gd);
        if(this._orient) {
            ly.get_context().set_base_gravity(Pango.Gravity.EAST);
            cr.moveTo(fh, 0);
            cr.rotate(Math.PI / 2);
        }
        PangoCairo.show_layout(cr, ly);
        cr.setSourceRGBA(...this._outline);
        PangoCairo.layout_path(cr, ly);
        cr.stroke();
        cr.restore();
    }

    destroy() {
        this._area.destroy();
        this._area = this.drag = null;
    }
};


(function () {
  const h = React.createElement;
  const { Select, Cascader, DatePicker, Radio, Checkbox, Form } = antd;
  const isV3 = window.fixtureLibrary === "antd3";
  const locationOptions = [{ value: "广东省", label: "广东省", children: [
    { value: "深圳市", label: "深圳市", children: [{ value: "南山区", label: "南山区" }, { value: "福田区", label: "福田区" }] },
    { value: "广州市", label: "广州市", children: [{ value: "天河区", label: "天河区" }] }
  ] }];
  function App() {
    const [values, setValues] = React.useState({ degree: undefined, school: undefined, location: [], date: null, month: null, range: [], gender: undefined, languages: [] });
    const update = (key) => (value) => setValues((old) => ({ ...old, [key]: value }));
    window.fixtureValues = { ...values, date: values.date?.format("YYYY-MM-DD") || "", month: values.month?.format("YYYY-MM") || "", range: (values.range || []).map((value) => value.format("YYYY-MM-DD")) };
    const field = (id, label, component) => h("div", { className: "fixture-field", "data-fixture-field": id, key: id }, h(Form.Item, { label }, component));
    const select = (id, options, showSearch = false) => h(Select, { id, style: { width: 300 }, value: values[id], onChange: update(id), allowClear: true, showSearch, optionFilterProp: "children", placeholder: "请选择" }, options.map((value) => h(Select.Option, { key: value, value }, value)));
    const monthProps = { id: "month", value: values.month, onChange: update("month"), format: "YYYY-MM", placeholder: "YYYY-MM", allowClear: true, inputReadOnly: true };
    return h("section", null, h("h1", null, `${isV3 ? "Ant Design 3" : "Ant Design 5"} 真实组件`), h(Form, { layout: "vertical" }, [
      field("degree", "学历", select("degree", ["本科", "硕士", "博士"])),
      field("school", "学校", select("school", ["示例大学", "星海大学", "远山学院"], true)),
      field("location", "所在地", h(Cascader, { id: "location", options: locationOptions, value: values.location, onChange: update("location"), allowClear: true, placeholder: "请选择地区", style: { width: 300 } })),
      field("date", "日期", h(DatePicker, { id: "date", value: values.date, onChange: update("date"), format: "YYYY-MM-DD", placeholder: "YYYY-MM-DD", allowClear: true, inputReadOnly: true })),
      field("month", "月份", isV3 ? h(DatePicker.MonthPicker, monthProps) : h(DatePicker, { ...monthProps, picker: "month" })),
      field("range", "任职时间", h(DatePicker.RangePicker, { value: values.range, onChange: update("range"), format: "YYYY-MM-DD", placeholder: ["开始日期", "结束日期"], allowClear: true, inputReadOnly: true })),
      field("gender", "性别", h(Radio.Group, { value: values.gender, onChange: (event) => update("gender")(event.target.value) }, ["男", "女"].map((value) => h(Radio, { key: value, value }, value)))),
      field("languages", "语言", h(Checkbox.Group, { value: values.languages, onChange: update("languages"), options: ["中文", "英语"] }))
    ]));
  }
  ReactDOM.render(h(App), document.getElementById("root"));
  window.fixtureReady = true;
})();

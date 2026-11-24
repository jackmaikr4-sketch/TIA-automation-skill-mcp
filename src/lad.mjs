function identifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value))
    throw Error('Use a simple ASCII PLC identifier');
  return value;
}
export function latchLad(name = 'MCP_LAD_Latch', number = 101) {
  identifier(name);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw Error('Invalid FC number');
  const access = (uid, n) =>
    `<Access Scope="LocalVariable" UId="${uid}"><Symbol><Component Name="${n}" /></Symbol></Access>`;
  const wire = (uid, ends) => `<Wire UId="${uid}">${ends}</Wire>`;
  const pin = (uid, n) => `<NameCon UId="${uid}" Name="${n}" />`;
  const ident = (uid) => `<IdentCon UId="${uid}" />`;
  const network = `<FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4"><Parts>${access(21, 'Start')}${access(22, 'Motor')}${access(23, 'Stop')}${access(24, 'Motor')}<Part Name="Contact" UId="31" /><Part Name="Contact" UId="32" /><Part Name="Contact" UId="33"><Negated Name="operand" /></Part><Part Name="Coil" UId="34" /><Part Name="O" UId="35"><TemplateValue Name="Card" Type="Cardinality">2</TemplateValue></Part></Parts><Wires>${wire(41, ident(21) + pin(31, 'operand'))}${wire(42, ident(22) + pin(32, 'operand'))}${wire(43, ident(23) + pin(33, 'operand'))}${wire(44, ident(24) + pin(34, 'operand'))}${wire(45, '<Powerrail />' + pin(31, 'in') + pin(32, 'in'))}${wire(46, pin(31, 'out') + pin(35, 'in1'))}${wire(47, pin(32, 'out') + pin(35, 'in2'))}${wire(48, pin(35, 'out') + pin(33, 'in'))}${wire(49, pin(33, 'out') + pin(34, 'in'))}</Wires></FlgNet>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Document><Engineering version="V18" /><SW.Blocks.FC ID="0"><AttributeList><AutoNumber>false</AutoNumber><Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5"><Section Name="Input"><Member Name="Start" Datatype="Bool" /><Member Name="Stop" Datatype="Bool" /></Section><Section Name="Output" /><Section Name="InOut"><Member Name="Motor" Datatype="Bool" /></Section><Section Name="Temp" /><Section Name="Constant" /><Section Name="Return"><Member Name="Ret_Val" Datatype="Void" /></Section></Sections></Interface><MemoryLayout>Optimized</MemoryLayout><Name>${name}</Name><Namespace /><Number>${number}</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList><SW.Blocks.CompileUnit ID="1" CompositionName="CompileUnits"><AttributeList><NetworkSource>${network}</NetworkSource><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.CompileUnit></ObjectList></SW.Blocks.FC></Document>
`;
}
export function wireTestCycleIntoMain(xml) {
  if (
    !/<Name>Main<\/Name>/.test(xml) ||
    !/<ProgrammingLanguage>LAD<\/ProgrammingLanguage>/.test(xml)
  )
    throw Error('Expected an exported LAD Main block');
  if ([...xml.matchAll(/<SW\.Blocks\.CompileUnit\b/g)].length !== 1)
    throw Error(
      'Test harness requires a fresh Main with exactly one network; refusing to replace user logic',
    );
  if (/<Part\b|<Call\b/.test(xml))
    throw Error('Main already contains logic; refusing to replace it');
  const network =
    '<NetworkSource><FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4"><Parts><Call UId="21"><CallInfo Name="MCP_TestCycle" BlockType="FC" /></Call></Parts><Wires><Wire UId="31"><Powerrail /><NameCon UId="21" Name="en" /></Wire><Wire UId="32"><NameCon UId="21" Name="eno" /><OpenCon UId="22" /></Wire></Wires></FlgNet></NetworkSource>';
  const re = /<NetworkSource(?:\s[^>]*)?>[\s\S]*?<\/NetworkSource>|<NetworkSource\s*\/>/;
  if (!re.test(xml)) throw Error('Main export contains no supported NetworkSource');
  return xml.replace(re, network);
}
